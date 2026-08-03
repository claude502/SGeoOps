import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  createRunWithOutbox,
  type CreateAnalysisRun,
} from "@/lib/analysis/repository";
import { db } from "@/lib/prisma";
import { parseSearchConsoleControlRequestScope } from "@/lib/search-console/internal-route";

export const SEARCH_CONSOLE_FINAL_DATA_LAG_DAYS = 3;
const SEARCH_CONSOLE_SOURCE = "search-console";
const SEARCH_CONSOLE_SOURCE_VERSION = "webmasters-v3";
const SEARCH_CONSOLE_ADAPTER_VERSION = "1.0.0";

export type SearchConsoleDispatchPayload = {
  runId: string;
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
  integrationId: string;
  property: string;
  startDate: string;
  endDate: string;
};

export interface SearchConsoleDispatcher {
  dispatch(scheduledAt: Date): Promise<SearchConsoleDispatchPayload[]>;
}

type DispatchDatabase = Pick<
  PrismaClient,
  "integration" | "analysisRun" | "$transaction"
>;

const existingRunSelect = {
  id: true,
  clientId: true,
  brandId: true,
  siteId: true,
  siteMarketId: true,
  kind: true,
  source: true,
  sourceVersion: true,
  adapterVersion: true,
  inputHash: true,
  idempotencyKey: true,
  trigger: true,
} satisfies Prisma.AnalysisRunSelect;

type ExistingRun = Prisma.AnalysisRunGetPayload<{
  select: typeof existingRunSelect;
}>;

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeFileSecretReference(value: string) {
  if (!value.startsWith("file:") || value.length > 500) return false;
  const relativePath = value.slice("file:".length);
  return relativePath.length > 0 &&
    !relativePath.startsWith("/") &&
    !relativePath.includes("\\") &&
    !relativePath.includes("\u0000") &&
    relativePath.split("/").every((segment) =>
      segment.length > 0 && segment !== "." && segment !== ".."
    );
}

export function searchConsoleFinalDate(scheduledAt: Date): string {
  if (!(scheduledAt instanceof Date) || !Number.isFinite(scheduledAt.getTime())) {
    throw new TypeError("Search Console scheduled time is invalid.");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(scheduledAt);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const date = new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
  date.setUTCDate(date.getUTCDate() - SEARCH_CONSOLE_FINAL_DATA_LAG_DAYS);
  return date.toISOString().slice(0, 10);
}

function runFacts(payload: SearchConsoleDispatchPayload) {
  const idempotencyKey = `search-console:${payload.integrationId}:${payload.startDate}`;
  const inputHash = `sha256:${digest([
    payload.clientId,
    payload.brandId,
    payload.siteId,
    payload.siteMarketId ?? "",
    payload.integrationId,
    payload.property,
    payload.startDate,
    payload.endDate,
  ].join("\u0000"))}`;
  const id = `sc-${digest(idempotencyKey).slice(0, 40)}`;
  return { id, idempotencyKey, inputHash };
}

function expectedRun(
  payload: SearchConsoleDispatchPayload,
): CreateAnalysisRun {
  const facts = runFacts(payload);
  return {
    id: facts.id,
    clientId: payload.clientId,
    brandId: payload.brandId,
    siteId: payload.siteId,
    siteMarketId: payload.siteMarketId,
    kind: "search-console-sync",
    source: SEARCH_CONSOLE_SOURCE,
    sourceVersion: SEARCH_CONSOLE_SOURCE_VERSION,
    adapterVersion: SEARCH_CONSOLE_ADAPTER_VERSION,
    status: "queued",
    inputHash: facts.inputHash,
    idempotencyKey: facts.idempotencyKey,
    trigger: "schedule",
  };
}

function assertMatchingRun(existing: ExistingRun | null, expected: CreateAnalysisRun) {
  if (
    existing === null ||
    existing.id !== expected.id ||
    existing.clientId !== expected.clientId ||
    existing.brandId !== expected.brandId ||
    existing.siteId !== expected.siteId ||
    existing.siteMarketId !== expected.siteMarketId ||
    existing.kind !== expected.kind ||
    existing.source !== expected.source ||
    existing.sourceVersion !== expected.sourceVersion ||
    existing.adapterVersion !== expected.adapterVersion ||
    existing.inputHash !== expected.inputHash ||
    existing.idempotencyKey !== expected.idempotencyKey ||
    existing.trigger !== expected.trigger
  ) {
    throw new Error("Search Console dispatch idempotency conflict.");
  }
}

function isUniqueConstraintError(error: unknown) {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "P2002";
}

export class PrismaSearchConsoleDispatchRepository implements SearchConsoleDispatcher {
  constructor(private readonly database: DispatchDatabase = db) {}

  async dispatch(scheduledAt: Date): Promise<SearchConsoleDispatchPayload[]> {
    const date = searchConsoleFinalDate(scheduledAt);
    const integrations = await this.database.integration.findMany({
      where: {
        type: "search_console",
        healthState: { not: "disabled" },
        endpoint: { not: null },
        secretRef: { not: null },
        site: {
          active: true,
          brand: { client: { active: true } },
        },
      },
      select: {
        id: true,
        siteId: true,
        siteMarketId: true,
        endpoint: true,
        secretRef: true,
        site: {
          select: {
            brandId: true,
            brand: { select: { clientId: true } },
          },
        },
        siteMarket: { select: { siteId: true } },
      },
      orderBy: { id: "asc" },
    });

    const payloads: SearchConsoleDispatchPayload[] = [];
    for (const integration of integrations) {
      if (
        integration.endpoint === null ||
        integration.secretRef === null ||
        !safeFileSecretReference(integration.secretRef) ||
        (integration.siteMarketId !== null &&
          integration.siteMarket?.siteId !== integration.siteId)
      ) {
        continue;
      }
      const scope = parseSearchConsoleControlRequestScope({
        clientId: integration.site.brand.clientId,
        brandId: integration.site.brandId,
        siteId: integration.siteId,
        siteMarketId: integration.siteMarketId,
        integrationId: integration.id,
        property: integration.endpoint,
      });
      if (scope === null) continue;
      const payload: SearchConsoleDispatchPayload = {
        runId: runFacts({
          ...scope,
          runId: "unused",
          startDate: date,
          endDate: date,
        }).id,
        ...scope,
        startDate: date,
        endDate: date,
      };
      await this.createOrReuse(payload);
      payloads.push(payload);
    }
    return payloads;
  }

  private async createOrReuse(payload: SearchConsoleDispatchPayload) {
    const expected = expectedRun(payload);
    try {
      await this.database.$transaction(async (tx) => {
        await tx.$queryRaw`
          WITH acquired AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(
              hashtextextended(${expected.idempotencyKey}, 7191::bigint)
            )
          )
          SELECT true AS locked FROM acquired
        `;
        const existing = await tx.analysisRun.findUnique({
          where: { idempotencyKey: expected.idempotencyKey },
          select: existingRunSelect,
        });
        if (existing !== null) {
          assertMatchingRun(existing, expected);
          return;
        }
        await createRunWithOutbox(tx, expected, {
          aggregateType: "AnalysisRun",
          aggregateId: expected.id,
          eventType: "analysis_run.created",
          payload: { runId: expected.id },
        });
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await this.database.analysisRun.findUnique({
        where: { idempotencyKey: expected.idempotencyKey },
        select: existingRunSelect,
      });
      assertMatchingRun(raced, expected);
    }
  }
}

export function createDefaultSearchConsoleDispatcher() {
  return new PrismaSearchConsoleDispatchRepository();
}
