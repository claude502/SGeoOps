import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { AnalysisEnvelope } from "@sgeo/analysis-contract";
import {
  createRunWithOutbox,
  ingestEnvelope,
  type CreateAnalysisRun,
} from "../../src/lib/analysis/repository";
import { Inbox } from "../../src/lib/events/inbox";

const integrationEnabled = process.env.SGEO_DATABASE_INTEGRATION === "1";
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
const checksum = `sha256:${"a".repeat(64)}`;
const otherChecksum = `sha256:${"b".repeat(64)}`;

let admin: Client;
let prisma: PrismaClient;
let schema = "";

function quoteIdentifier(identifier: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

const baseRun: CreateAnalysisRun = {
  id: "run_1",
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: "market_1",
  kind: "site-audit",
  source: "siteone",
  sourceVersion: "2.0.0",
  adapterVersion: "1.0.0",
  status: "queued",
  inputHash: "sha256:input",
  idempotencyKey: "run_1:key",
  trigger: "manual",
};

const envelope: AnalysisEnvelope = {
  contractVersion: "1",
  runId: "run_1",
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: "market_1",
  source: "siteone",
  sourceVersion: "2.0.0",
  adapterVersion: "1.0.0",
  status: "succeeded",
  startedAt: "2026-07-31T01:00:00.000Z",
  finishedAt: "2026-07-31T01:01:00.000Z",
  rawArtifact: {
    uri: "artifact://run_1/report.json",
    checksum,
    mediaType: "application/json",
    byteSize: 42,
  },
  observations: [{
    kind: "http_status",
    subject: "https://example.com/",
    value: { status: 200 },
    observedAt: "2026-07-31T01:00:30.000Z",
    surface: "api",
  }],
  error: null,
};

async function seedRun(run: CreateAnalysisRun = baseRun) {
  await prisma.analysisRun.create({ data: run });
}

async function counts() {
  const [runs, artifacts, observations, outbox] = await Promise.all([
    prisma.analysisRun.count(),
    prisma.rawArtifact.count(),
    prisma.observation.count(),
    prisma.outboxEvent.count(),
  ]);
  return { runs, artifacts, observations, outbox };
}

describe.skipIf(!integrationEnabled).sequential(
  "Task 8 transaction primitives on PostgreSQL 16",
  () => {
    beforeAll(async () => {
      if (!databaseUrl) {
        throw new Error(
          "TEST_DATABASE_URL is required for database integration tests",
        );
      }
      const parsed = new URL(databaseUrl);
      const databaseName = decodeURIComponent(parsed.pathname.slice(1));
      if (!/^sgeo_task(?:4|7|8)_test(?:_|$)/.test(databaseName)) {
        throw new Error(
          `Refusing database integration tests against ${databaseName}`,
        );
      }
      parsed.searchParams.delete("schema");
      const connectionString = parsed.toString();
      admin = new Client({
        connectionString,
        application_name: "sgeo-task8-primitives",
      });
      await admin.connect();
      const version = await admin.query<{ version: string }>(
        "SELECT current_setting('server_version_num') AS version",
      );
      expect(Number(version.rows[0]?.version)).toBeGreaterThanOrEqual(160_000);
      expect(Number(version.rows[0]?.version)).toBeLessThan(170_000);

      schema = `sgeo_task8_${process.pid}_${randomUUID()
        .replaceAll("-", "")
        .slice(0, 10)}`;
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await admin.query(`
        CREATE TYPE "RunStatus" AS ENUM (
          'queued', 'running', 'succeeded', 'partial',
          'retrying', 'failed', 'cancelled'
        );
        CREATE TABLE "AnalysisRun" (
          "id" TEXT PRIMARY KEY,
          "clientId" TEXT NOT NULL,
          "brandId" TEXT NOT NULL,
          "siteId" TEXT NOT NULL,
          "siteMarketId" TEXT,
          "kind" TEXT NOT NULL,
          "source" TEXT NOT NULL,
          "sourceVersion" TEXT NOT NULL,
          "adapterVersion" TEXT NOT NULL,
          "status" "RunStatus" NOT NULL,
          "inputHash" TEXT NOT NULL,
          "idempotencyKey" TEXT NOT NULL UNIQUE,
          "trigger" TEXT NOT NULL,
          "attemptCount" INTEGER NOT NULL DEFAULT 0,
          "errorCode" TEXT,
          "errorSummary" TEXT,
          "startedAt" TIMESTAMP(3),
          "finishedAt" TIMESTAMP(3),
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE "RawArtifact" (
          "id" TEXT PRIMARY KEY,
          "runId" TEXT NOT NULL REFERENCES "AnalysisRun"("id") ON DELETE RESTRICT,
          "uri" TEXT NOT NULL UNIQUE,
          "mediaType" TEXT NOT NULL,
          "checksum" TEXT NOT NULL,
          "byteSize" INTEGER NOT NULL,
          "sourceVersion" TEXT NOT NULL,
          "retentionAt" TIMESTAMP(3) NOT NULL,
          "redacted" BOOLEAN NOT NULL DEFAULT false,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE "Observation" (
          "id" TEXT PRIMARY KEY,
          "runId" TEXT NOT NULL REFERENCES "AnalysisRun"("id") ON DELETE RESTRICT,
          "kind" TEXT NOT NULL,
          "subject" TEXT NOT NULL,
          "value" JSONB NOT NULL,
          "surface" TEXT,
          "provider" TEXT,
          "model" TEXT,
          "promptVersion" INTEGER,
          "country" TEXT,
          "locale" TEXT,
          "observedAt" TIMESTAMP(3) NOT NULL
        );
        CREATE TABLE "OutboxEvent" (
          "id" TEXT PRIMARY KEY,
          "aggregateType" TEXT NOT NULL,
          "aggregateId" TEXT NOT NULL,
          "eventType" TEXT NOT NULL,
          "payload" JSONB NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'pending',
          "attemptCount" INTEGER NOT NULL DEFAULT 0,
          "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "sentAt" TIMESTAMP(3),
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE "InboxEvent" (
          "id" TEXT PRIMARY KEY,
          "source" TEXT NOT NULL,
          "externalId" TEXT NOT NULL,
          "eventType" TEXT NOT NULL,
          "payloadHash" TEXT NOT NULL,
          "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE ("source", "externalId")
        );
      `);
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString }, { schema }),
      });
    });

    afterAll(async () => {
      await prisma?.$disconnect();
      if (!admin) return;
      await admin.query("SET search_path TO public");
      if (schema.startsWith("sgeo_task8_")) {
        await admin.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
        );
      }
      await admin.end();
    });

    beforeEach(async () => {
      await admin.query(`
        TRUNCATE TABLE
          "InboxEvent", "OutboxEvent", "Observation", "RawArtifact",
          "AnalysisRun"
        CASCADE
      `);
    });

    it("commits run and outbox together and rolls both back on failure", async () => {
      await prisma.$transaction((tx) =>
        createRunWithOutbox(tx, baseRun, {
          aggregateType: "AnalysisRun",
          aggregateId: "run_1",
          eventType: "analysis_run.created",
          payload: { runId: "run_1" },
        })
      );
      await expect(counts()).resolves.toMatchObject({ runs: 1, outbox: 1 });

      await admin.query(
        'TRUNCATE TABLE "OutboxEvent", "AnalysisRun" CASCADE',
      );
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(
        prisma.$transaction((tx) =>
          createRunWithOutbox(tx, baseRun, {
            aggregateType: "AnalysisRun",
            aggregateId: "run_1",
            eventType: "analysis_run.created",
            payload: circular,
          })
        ),
      ).rejects.toMatchObject({ code: "OUTBOX_PAYLOAD_INVALID" });
      await expect(counts()).resolves.toMatchObject({ runs: 0, outbox: 0 });
    });

    it("claims concurrent inbox deliveries without aborting transactions", async () => {
      const same = await Promise.all([
        prisma.$transaction((tx) =>
          new Inbox(tx).claim("geoflow", "event_same", "hash_1")
        ),
        prisma.$transaction((tx) =>
          new Inbox(tx).claim("geoflow", "event_same", "hash_1")
        ),
      ]);
      expect(same.sort()).toEqual([false, true]);

      const different = await Promise.allSettled([
        prisma.$transaction((tx) =>
          new Inbox(tx).claim("geoflow", "event_other", "hash_a")
        ),
        prisma.$transaction((tx) =>
          new Inbox(tx).claim("geoflow", "event_other", "hash_b")
        ),
      ]);
      expect(different.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const rejection = different.find((result) => result.status === "rejected");
      expect(rejection).toMatchObject({
        reason: { code: "INBOX_PAYLOAD_CONFLICT" },
      });
      await expect(prisma.inboxEvent.count()).resolves.toBe(2);
    });

    it("ingests evidence, rejects ownership drift, and replays exactly once", async () => {
      await seedRun();
      await prisma.$transaction((tx) => ingestEnvelope(tx, envelope));
      await expect(counts()).resolves.toEqual({
        runs: 1,
        artifacts: 1,
        observations: 1,
        outbox: 1,
      });
      const run = await prisma.analysisRun.findUniqueOrThrow({
        where: { id: "run_1" },
      });
      expect(run).toMatchObject({
        status: "succeeded",
        errorCode: null,
        errorSummary: null,
      });

      await prisma.$transaction((tx) => ingestEnvelope(tx, envelope));
      await expect(counts()).resolves.toEqual({
        runs: 1,
        artifacts: 1,
        observations: 1,
        outbox: 1,
      });

      await expect(
        prisma.$transaction((tx) =>
          ingestEnvelope(tx, { ...envelope, clientId: "client_2" })
        ),
      ).rejects.toMatchObject({ code: "ANALYSIS_OWNERSHIP_MISMATCH" });
      await expect(counts()).resolves.toEqual({
        runs: 1,
        artifacts: 1,
        observations: 1,
        outbox: 1,
      });
    });

    it("rejects a different artifact checksum without changing facts", async () => {
      await seedRun();
      await prisma.$transaction((tx) => ingestEnvelope(tx, envelope));

      await expect(
        prisma.$transaction((tx) =>
          ingestEnvelope(tx, {
            ...envelope,
            rawArtifact: { ...envelope.rawArtifact!, checksum: otherChecksum },
          })
        ),
      ).rejects.toMatchObject({ code: "ANALYSIS_ARTIFACT_CONFLICT" });
      await expect(counts()).resolves.toEqual({
        runs: 1,
        artifacts: 1,
        observations: 1,
        outbox: 1,
      });
    });

    it("deduplicates concurrent and null-artifact replays", async () => {
      await seedRun();
      const withoutArtifact = { ...envelope, rawArtifact: null };
      await Promise.all([
        prisma.$transaction((tx) => ingestEnvelope(tx, withoutArtifact)),
        prisma.$transaction((tx) => ingestEnvelope(tx, withoutArtifact)),
      ]);
      await prisma.$transaction((tx) =>
        ingestEnvelope(tx, withoutArtifact)
      );

      await expect(counts()).resolves.toEqual({
        runs: 1,
        artifacts: 0,
        observations: 1,
        outbox: 1,
      });
    });

    it("rolls back artifact, observations, update, and marker after a middle failure", async () => {
      await seedRun();
      await admin.query(`
        CREATE OR REPLACE FUNCTION ${quoteIdentifier(schema)}.fail_observation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW."subject" = 'force-failure' THEN
            RAISE EXCEPTION 'forced observation failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER "task8_fail_observation"
          BEFORE INSERT ON "Observation"
          FOR EACH ROW EXECUTE FUNCTION
            ${quoteIdentifier(schema)}.fail_observation()
      `);
      const failing = {
        ...envelope,
        observations: [{
          ...envelope.observations[0],
          subject: "force-failure",
        }],
      };

      await expect(
        prisma.$transaction((tx) => ingestEnvelope(tx, failing)),
      ).rejects.toThrow(/forced observation failure/);
      await admin.query(
        'DROP TRIGGER "task8_fail_observation" ON "Observation"',
      );
      await expect(counts()).resolves.toEqual({
        runs: 1,
        artifacts: 0,
        observations: 0,
        outbox: 0,
      });
      const run = await prisma.analysisRun.findUniqueOrThrow({
        where: { id: "run_1" },
      });
      expect(run.status).toBe("queued");
    });
  },
);
