import { describe, expect, it, vi } from "vitest";

import {
  PrismaSearchConsoleDispatchRepository,
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
  let existingRun: Record<string, unknown> | null = null;
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
    analysisRun: {
      findUnique: vi.fn(async () => existingRun),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        existingRun = { ...data };
        return data;
      }),
    },
    outboxEvent: { create: vi.fn().mockResolvedValue({ id: "event_1" }) },
  };
  const database = {
    integration: { findMany: vi.fn().mockResolvedValue(integrations) },
    analysisRun: { findUnique: vi.fn(async () => existingRun) },
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

    const first = await repository.dispatch(scheduledAt);
    const second = await repository.dispatch(scheduledAt);

    expect(first).toEqual(second);
    expect(first).toEqual([expect.objectContaining({
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
        payload: { runId: first[0]?.runId },
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

    await expect(repository.dispatch(new Date("2026-08-04T07:30:00.000Z")))
      .resolves.toEqual([]);
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("recovers a matching run after a database uniqueness race", async () => {
    const { repository, database, transaction } = harness();
    transaction.analysisRun.create.mockImplementationOnce(async ({ data }) => {
      database.analysisRun.findUnique.mockResolvedValueOnce({ ...data });
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    });

    const result = await repository.dispatch(new Date("2026-08-04T07:30:00.000Z"));

    expect(result).toEqual([expect.objectContaining({
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

    await expect(repository.dispatch(new Date("2026-08-04T07:30:00.000Z")))
      .rejects.toThrow("database unavailable");
  });
});
