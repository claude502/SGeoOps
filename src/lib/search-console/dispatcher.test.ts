import { describe, expect, it, vi } from "vitest";

import {
  PrismaSearchConsoleDispatchRepository,
  SEARCH_CONSOLE_DISPATCH_PAGE_SIZE,
  SEARCH_CONSOLE_FINAL_DATA_LAG_DAYS,
  searchConsoleFinalDate,
} from "./dispatcher";

const validIntegration = {
  id: "integration_1",
  siteId: "site_1",
  siteMarketId: null,
  endpoint: "sc-domain:shop.example",
  secretRef: "file:google/search-console",
  site: {
    brandId: "brand_1",
    brand: { clientId: "client_1" },
  },
  siteMarket: null,
};

function harness(integrations: unknown[] = [validIntegration]) {
  const existingRuns = new Map<string, Record<string, unknown>>();
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
    analysisRun: {
      findUnique: vi.fn(async ({ where }: { where: { idempotencyKey: string } }) =>
        existingRuns.get(where.idempotencyKey) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        existingRuns.set(data.idempotencyKey as string, { ...data });
        return data;
      }),
    },
    outboxEvent: { create: vi.fn().mockResolvedValue({ id: "event_1" }) },
  };
  const database = {
    integration: {
      findMany: vi.fn(async (args?: {
        where?: { id?: { gt?: string } };
        take?: number;
      }) => {
        const after = args?.where?.id?.gt;
        const candidates = (integrations as Array<{ id: string }>)
          .filter((integration) => after === undefined || integration.id > after)
          .sort((left, right) => left.id.localeCompare(right.id));
        return candidates.slice(0, args?.take ?? candidates.length);
      }),
    },
    analysisRun: {
      findUnique: vi.fn(async ({ where }: { where: { idempotencyKey: string } }) =>
        existingRuns.get(where.idempotencyKey) ?? null),
    },
    $transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) =>
      operation(transaction)),
  };
  return {
    database,
    transaction,
    repository: new PrismaSearchConsoleDispatchRepository(database as never),
  };
}

describe("Search Console daily dispatcher", () => {
  it("derives the final date three Pacific calendar days behind the schedule instant", () => {
    expect(SEARCH_CONSOLE_FINAL_DATA_LAG_DAYS).toBe(3);
    expect(searchConsoleFinalDate(new Date("2026-08-04T06:30:00.000Z"))).toBe("2026-07-31");
    expect(searchConsoleFinalDate(new Date("2026-08-04T07:30:00.000Z"))).toBe("2026-08-01");
  });

  it("creates one owned no-secret run and outbox event, then reuses it idempotently", async () => {
    const { database, repository, transaction } = harness();
    const scheduledAt = new Date("2026-08-04T07:30:00.000Z");

    const first = await repository.dispatchPage(scheduledAt, null);
    const second = await repository.dispatchPage(scheduledAt, null);

    expect(first).toEqual(second);
    expect(first.runs).toEqual([expect.objectContaining({
      clientId: "client_1",
      brandId: "brand_1",
      siteId: "site_1",
      siteMarketId: null,
      integrationId: "integration_1",
      property: "sc-domain:shop.example",
      startDate: "2026-08-01",
      endDate: "2026-08-01",
    })]);
    expect(JSON.stringify(first)).not.toMatch(/file:|secretRef|token/i);
    expect(database.integration.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        type: "search_console",
        healthState: { not: "disabled" },
        endpoint: { not: null },
        secretRef: { not: null },
      }),
    }));
    expect(transaction.analysisRun.create).toHaveBeenCalledTimes(1);
    expect(transaction.analysisRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientId: "client_1",
        brandId: "brand_1",
        siteId: "site_1",
        siteMarketId: null,
        kind: "search-console-sync",
        source: "search-console",
        sourceVersion: "webmasters-v3",
        adapterVersion: "1.0.0",
        status: "queued",
        trigger: "schedule",
        idempotencyKey: "search-console:integration_1:2026-08-01",
      }),
    });
    expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: "AnalysisRun",
        eventType: "analysis_run.created",
        payload: { runId: first.runs[0]?.runId },
      }),
    });
  });

  it("skips invalid properties, unsafe secret references, and cross-site market scope", async () => {
    const { repository, database } = harness([
      { ...validIntegration, id: "invalid_property", endpoint: "https://user:pass@example.com/" },
      { ...validIntegration, id: "invalid_secret", secretRef: "vault:token" },
      {
        ...validIntegration,
        id: "cross_site_market",
        siteMarketId: "market_2",
        siteMarket: { id: "market_2", siteId: "site_2" },
      },
    ]);

    await expect(repository.dispatchPage(new Date("2026-08-04T07:30:00.000Z"), null))
      .resolves.toEqual({ runs: [], nextAfterIntegrationId: null });
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("recovers a matching run after a database uniqueness race", async () => {
    const { repository, database, transaction } = harness();
    transaction.analysisRun.create.mockImplementationOnce(async ({ data }) => {
      database.analysisRun.findUnique.mockResolvedValueOnce({ ...data });
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    });

    const result = await repository.dispatchPage(new Date("2026-08-04T07:30:00.000Z"), null);

    expect(result.runs).toEqual([expect.objectContaining({
      integrationId: "integration_1",
      startDate: "2026-08-01",
      endDate: "2026-08-01",
    })]);
    expect(database.analysisRun.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: "search-console:integration_1:2026-08-01" },
      select: expect.any(Object),
    });
  });

  it("propagates database failures instead of silently omitting an integration", async () => {
    const { repository, database } = harness();
    database.$transaction.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(repository.dispatchPage(new Date("2026-08-04T07:30:00.000Z"), null))
      .rejects.toThrow("database unavailable");
  });

  it("pages more than the control response limit without missing or duplicating eligible integrations", async () => {
    const boundedIdentifier = (prefix: string, index: number) => {
      const value = `${prefix}_${String(index).padStart(3, "0")}`;
      return `${value}${"x".repeat(200 - value.length)}`;
    };
    const integrations = Array.from({ length: 251 }, (_, index) => ({
      ...validIntegration,
      id: boundedIdentifier("integration", index),
      siteId: boundedIdentifier("site", index),
      siteMarketId: boundedIdentifier("market", index),
      endpoint: `https://shop${index}.example/${"a".repeat(
        2_048 - `https://shop${index}.example/`.length,
      )}`,
      site: {
        brandId: boundedIdentifier("brand", index),
        brand: { clientId: boundedIdentifier("client", index) },
      },
      siteMarket: { siteId: boundedIdentifier("site", index) },
    }));
    const { repository } = harness(integrations);
    const received: Array<{ runId: string; integrationId: string }> = [];
    let after: string | null = null;
    let pages = 0;

    do {
      const page = await repository.dispatchPage(
        new Date("2026-08-04T07:30:00.000Z"),
        after,
      );
      pages += 1;
      expect(page.runs.length).toBeLessThanOrEqual(SEARCH_CONSOLE_DISPATCH_PAGE_SIZE);
      expect(Buffer.byteLength(JSON.stringify({
        runs: page.runs,
        cursor: "x".repeat(512),
      }), "utf8")).toBeLessThanOrEqual(64 * 1024);
      received.push(...page.runs);
      after = page.nextAfterIntegrationId;
    } while (after !== null);

    expect(pages).toBeGreaterThan(1);
    expect(received).toHaveLength(integrations.length);
    expect(new Set(received.map((run) => run.runId)).size).toBe(integrations.length);
    expect(received.map((run) => run.integrationId)).toEqual(
      integrations.map((integration) => integration.id),
    );
  });
});
