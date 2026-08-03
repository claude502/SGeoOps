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
    const client = { dispatchSearchConsoleRuns: vi.fn().mockResolvedValue(runs) };
    const batchTrigger = vi.fn().mockResolvedValue({ batchId: "batch_1" });

    await expect(runSearchConsoleDailyDispatch(
      new Date("2026-08-04T04:00:00.000Z"),
      { client, batchTrigger },
    )).resolves.toEqual({ dispatched: 2, runIds: ["run_sc_1", "run_sc_2"] });

    expect(client.dispatchSearchConsoleRuns).toHaveBeenCalledWith("2026-08-04T04:00:00.000Z");
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
      client: { dispatchSearchConsoleRuns: vi.fn().mockRejectedValue(failure) },
      batchTrigger: vi.fn(),
    })).rejects.toBe(failure);

    const source = await readFile(new URL("./search-console-daily.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/DATABASE_URL|\bPrisma\b|\bprisma\b|token|secretRef/);
  });
});
