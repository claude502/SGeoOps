import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const triggerMocks = vi.hoisted(() => ({
  schedule: vi.fn((definition: { id: string; run: (payload: unknown) => Promise<unknown> }) => ({
    id: definition.id,
    run: definition.run,
  })),
  batchTrigger: vi.fn(),
  task: vi.fn((definition: { id: string; run: (payload: unknown) => Promise<unknown> }) => ({
    id: definition.id,
    run: definition.run,
    batchTrigger: triggerMocks.batchTrigger,
  })),
}));

vi.mock("@trigger.dev/sdk", () => ({
  schedules: { task: triggerMocks.schedule },
  task: triggerMocks.task,
  logger: { warn: vi.fn() },
  metadata: { current: vi.fn(), set: vi.fn() },
  AbortTaskRunError: class AbortTaskRunError extends Error {},
}));

const {
  runSearchConsoleDailyDispatch,
  searchConsoleDailyDispatchTask,
} = await import("./search-console-daily");

const runs = ["1", "2"].map((suffix) => ({
  runId: `run_sc_${suffix}`,
  clientId: "client_1",
  brandId: "brand_1",
  siteId: `site_${suffix}`,
  siteMarketId: null,
  integrationId: `integration_${suffix}`,
  property: `sc-domain:shop${suffix}.example`,
  startDate: "2026-08-01",
  endDate: "2026-08-01",
}));

describe("Search Console daily scheduled dispatch", () => {
  it("registers the real Trigger v4 cron and triggers one sync task per typed payload", async () => {
    const client = {
      dispatchSearchConsolePage: vi.fn().mockResolvedValue({ runs, cursor: null }),
    };
    const batchTrigger = vi.fn().mockResolvedValue({ batchId: "batch_1" });

    await expect(runSearchConsoleDailyDispatch(
      new Date("2026-08-04T04:00:00.000Z"),
      { client, batchTrigger },
    )).resolves.toEqual({ dispatched: 2, runIds: ["run_sc_1", "run_sc_2"] });

    expect(client.dispatchSearchConsolePage).toHaveBeenCalledWith(
      "2026-08-04T04:00:00.000Z",
      null,
    );
    expect(batchTrigger).toHaveBeenCalledOnce();
    expect(batchTrigger).toHaveBeenCalledWith(runs.map((payload) => ({
      payload,
      options: { idempotencyKey: payload.runId },
    })));
    const [definition] = triggerMocks.schedule.mock.calls[0] as [Record<string, unknown>];
    expect(searchConsoleDailyDispatchTask.id).toBe("search-console-daily-dispatch");
    expect(definition).toMatchObject({
      id: "search-console-daily-dispatch",
      cron: { pattern: "0 4 * * *", timezone: "UTC" },
      retry: { maxAttempts: 3 },
    });
  });

  it("propagates dispatcher failures and remains database-free", async () => {
    const failure = new Error("control plane unavailable");
    await expect(runSearchConsoleDailyDispatch(new Date(), {
      client: { dispatchSearchConsolePage: vi.fn().mockRejectedValue(failure) },
      batchTrigger: vi.fn(),
    })).rejects.toBe(failure);

    const source = await readFile(new URL("./search-console-daily.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/DATABASE_URL|\bPrisma\b|\bprisma\b|token|secretRef/);
  });

  it("dispatches every page beyond the control response limit exactly once", async () => {
    const manyRuns = Array.from({ length: 251 }, (_, index) => ({
      ...runs[0]!,
      runId: `run_sc_${String(index).padStart(3, "0")}`,
      integrationId: `integration_${String(index).padStart(3, "0")}`,
      siteId: `site_${String(index).padStart(3, "0")}`,
      property: `sc-domain:shop${index}.example`,
    }));
    const pageSize = 16;
    const client = {
      dispatchSearchConsolePage: vi.fn(async (
        _scheduledAt: string,
        cursor: string | null,
      ) => {
        const offset = cursor === null ? 0 : Number(cursor.slice("cursor-".length));
        const nextOffset = offset + pageSize;
        return {
          runs: manyRuns.slice(offset, nextOffset),
          cursor: nextOffset < manyRuns.length ? `cursor-${nextOffset}` : null,
        };
      }),
    };
    const batchTrigger = vi.fn().mockResolvedValue({ batchId: "batch" });

    const result = await runSearchConsoleDailyDispatch(
      new Date("2026-08-04T04:00:00.000Z"),
      { client, batchTrigger },
    );

    expect(result).toEqual({
      dispatched: manyRuns.length,
      runIds: manyRuns.map((run) => run.runId),
    });
    expect(client.dispatchSearchConsolePage).toHaveBeenCalledTimes(Math.ceil(manyRuns.length / pageSize));
    expect(batchTrigger).toHaveBeenCalledTimes(Math.ceil(manyRuns.length / pageSize));
    const triggered = batchTrigger.mock.calls.flatMap(([items]) =>
      (items as Array<{ payload: { runId: string } }>).map((item) => item.payload.runId),
    );
    expect(triggered).toEqual(manyRuns.map((run) => run.runId));
    expect(new Set(triggered).size).toBe(manyRuns.length);
  });
});
