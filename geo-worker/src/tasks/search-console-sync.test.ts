import type { AnalysisEnvelope } from "@sgeo/analysis-contract";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  executeSearchConsole,
  type SearchConsoleInput,
} from "../adapters/search-console";
import type { SearchConsoleDeliveryState } from "./search-console-sync";
import {
  SEARCH_CONSOLE_MAX_RESPONSE_BYTES,
  SearchConsoleAuthenticationError,
  SearchConsoleClient,
  SearchConsoleProviderError,
} from "../clients/search-console";

const triggerMocks = vi.hoisted(() => ({
  task: vi.fn((definition: { id: string; run: (input: unknown) => Promise<unknown> }) => ({
    id: definition.id,
    run: definition.run,
  })),
  warn: vi.fn(),
  metadata: {
    current: vi.fn(),
    set: vi.fn(),
  },
  AbortTaskRunError: class AbortTaskRunError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AbortTaskRunError";
    }
  },
}));

vi.mock("@trigger.dev/sdk", () => ({
  task: triggerMocks.task,
  logger: { warn: triggerMocks.warn },
  metadata: triggerMocks.metadata,
  AbortTaskRunError: triggerMocks.AbortTaskRunError,
}));

const {
  createTriggerMetadataCheckpoint,
  runSearchConsoleSync,
  runSearchConsoleSyncTask,
  SEARCH_CONSOLE_DAILY_DISPATCH_CRON,
  SEARCH_CONSOLE_TRIGGER_ENVELOPE_BYTES,
  searchConsoleSyncTask,
} = await import("./search-console-sync");

const input: SearchConsoleInput = {
  runId: "run_sc_1",
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: null,
  integrationId: "integration_1",
  property: "sc-domain:shop.example",
  startDate: "2026-07-01",
  endDate: "2026-07-02",
};

const envelope: AnalysisEnvelope = {
  contractVersion: "1",
  runId: input.runId,
  clientId: input.clientId,
  brandId: input.brandId,
  siteId: input.siteId,
  siteMarketId: input.siteMarketId,
  source: "search-console",
  sourceVersion: "webmasters-v3",
  adapterVersion: "1.0.0",
  status: "succeeded",
  startedAt: "2026-08-03T00:00:00.000Z",
  finishedAt: "2026-08-03T00:00:01.000Z",
  rawArtifact: null,
  observations: [],
  error: null,
};

const token = "google-access-token-never-persist";
const rawReport = new TextEncoder().encode('{"schemaVersion":"search-console-pages-v1"}\n');

function ops(overrides: Record<string, unknown> = {}) {
  return {
    getSearchConsoleCredential: vi.fn().mockResolvedValue({ token }),
    reportSearchConsoleAuthenticationFailure: vi.fn().mockResolvedValue({
      disabled: true,
      recommendationId: "sc-auth-deterministic",
    }),
    uploadArtifact: vi.fn().mockResolvedValue({
      uri: `artifact://${input.runId}/search-console-pages-v1.bin`,
      checksum: `sha256:${"a".repeat(64)}`,
      mediaType: "application/vnd.sgeo.search-console-pages.v1",
      byteSize: rawReport.byteLength,
    }),
    ingest: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("searchConsoleSyncTask", () => {
  it("registers a bounded payload task with the daily cron contract and three-attempt budget", async () => {
    expect(searchConsoleSyncTask.id).toBe("search-console-sync");
    expect(SEARCH_CONSOLE_DAILY_DISPATCH_CRON).toBe("0 4 * * *");
    expect(SEARCH_CONSOLE_TRIGGER_ENVELOPE_BYTES).toBe(192 * 1024);
    const [definition] = triggerMocks.task.mock.calls[0] as [Record<string, unknown>];
    expect(definition).toMatchObject({
      id: "search-console-sync",
      queue: { name: "search-console", concurrencyLimit: 2 },
      machine: "medium-1x",
      maxDuration: 900,
      retry: { maxAttempts: 3 },
    });
    const source = await readFile(new URL("./search-console-sync.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/schedules\.task|DATABASE_URL|\bPrisma\b|\bprisma\b/);
  });

  it("gets the scoped credential, uploads raw bytes, checkpoints, then ingests without persisting the token", async () => {
    const order: string[] = [];
    const client = ops({
      getSearchConsoleCredential: vi.fn(async () => {
        order.push("credential");
        return { token };
      }),
      uploadArtifact: vi.fn(async () => {
        order.push("upload");
        return {
          uri: `artifact://${input.runId}/search-console-pages-v1.bin`,
          checksum: `sha256:${"b".repeat(64)}`,
          mediaType: "application/vnd.sgeo.search-console-pages.v1",
          byteSize: rawReport.byteLength,
        };
      }),
      ingest: vi.fn(async (received: AnalysisEnvelope) => {
        order.push("ingest");
        expect(received.rawArtifact?.uri).toContain("search-console-pages-v1.bin");
      }),
    });
    const saved: unknown[] = [];
    const checkpoint = {
      load: vi.fn().mockResolvedValue(null),
      assertCapacity: vi.fn(async () => {}),
      save: vi.fn(async (state: unknown) => {
        order.push("checkpoint");
        saved.push(state);
      }),
    };
    const execute = vi.fn(async (_input: SearchConsoleInput, receivedToken: string) => {
      order.push("execute");
      expect(receivedToken).toBe(token);
      return { envelope, rawReport };
    });

    await runSearchConsoleSync(input, { client, checkpoint, execute });

    expect(order).toEqual(["credential", "execute", "upload", "checkpoint", "ingest"]);
    expect(client.getSearchConsoleCredential).toHaveBeenCalledWith(input.runId, {
      clientId: input.clientId,
      brandId: input.brandId,
      siteId: input.siteId,
      siteMarketId: input.siteMarketId,
      integrationId: input.integrationId,
      property: input.property,
    });
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(client.uploadArtifact).toHaveBeenCalledWith(
      input.runId,
      "search-console-pages-v1.bin",
      rawReport,
      "application/vnd.sgeo.search-console-pages.v1",
    );
  });

  it("replays a ready checkpoint so an ingest retry does not refetch credentials, provider data, or artifacts", async () => {
    let savedState: SearchConsoleDeliveryState | null = null;
    const checkpoint = {
      load: vi.fn(async () => savedState),
      assertCapacity: vi.fn(async () => {}),
      save: vi.fn(async (state: SearchConsoleDeliveryState) => {
        savedState = state;
      }),
    };
    const execute = vi.fn().mockResolvedValue({ envelope, rawReport });
    const ingest = vi.fn()
      .mockRejectedValueOnce(new Error("temporary ingest outage"))
      .mockResolvedValueOnce(undefined);
    const client = ops({ ingest });
    const dependencies = { client, checkpoint, execute };

    await expect(runSearchConsoleSync(input, dependencies)).rejects.toThrow("temporary ingest outage");
    await expect(runSearchConsoleSync(input, dependencies)).resolves.toMatchObject({ runId: input.runId });

    expect(client.getSearchConsoleCredential).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(client.uploadArtifact).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(2);
  });

  it("checkpoints an authentication failure, disables exactly its scoped integration, then ingests a failed envelope", async () => {
    const order: string[] = [];
    const saved: Array<{ stage: string; envelope: AnalysisEnvelope }> = [];
    const client = ops({
      reportSearchConsoleAuthenticationFailure: vi.fn(async () => {
        order.push("report-auth-failure");
        return { disabled: true, recommendationId: "sc-auth-deterministic" };
      }),
      ingest: vi.fn(async (received: AnalysisEnvelope) => {
        order.push("ingest");
        expect(received).toMatchObject({
          status: "failed",
          error: { code: "SEARCH_CONSOLE_AUTHENTICATION_FAILED", retryable: false },
        });
      }),
    });
    const checkpoint = {
      load: vi.fn().mockResolvedValue(null),
      assertCapacity: vi.fn(async () => {}),
      save: vi.fn(async (state: { stage: string; envelope: AnalysisEnvelope }) => {
        order.push(`checkpoint-${state.stage}`);
        saved.push(state);
      }),
    };
    const execute = vi.fn().mockRejectedValue(new SearchConsoleAuthenticationError(401));

    const result = await runSearchConsoleSync(input, { client, checkpoint, execute });

    expect(result.status).toBe("failed");
    expect(order).toEqual([
      "checkpoint-auth-failure-pending",
      "report-auth-failure",
      "checkpoint-ready",
      "ingest",
    ]);
    expect(client.reportSearchConsoleAuthenticationFailure).toHaveBeenCalledWith(
      input.runId,
      expect.objectContaining({ integrationId: input.integrationId }),
    );
    expect(client.uploadArtifact).not.toHaveBeenCalled();
    expect(JSON.stringify(saved)).not.toContain(token);
  });

  it("resumes an auth-failure-pending checkpoint without asking for the disabled credential", async () => {
    const failedEnvelope: AnalysisEnvelope = {
      ...envelope,
      status: "failed",
      error: {
        code: "SEARCH_CONSOLE_AUTHENTICATION_FAILED",
        message: "Search Console credentials were rejected.",
        retryable: false,
      },
    };
    const client = ops();
    const checkpoint = {
      load: vi.fn().mockResolvedValue({ stage: "auth-failure-pending", envelope: failedEnvelope }),
      assertCapacity: vi.fn(),
      save: vi.fn(),
    };
    const execute = vi.fn();

    await expect(runSearchConsoleSync(input, { client, checkpoint, execute }))
      .resolves.toEqual(failedEnvelope);

    expect(client.reportSearchConsoleAuthenticationFailure).toHaveBeenCalledTimes(1);
    expect(checkpoint.save).toHaveBeenCalledWith({ stage: "ready", envelope: failedEnvelope });
    expect(client.ingest).toHaveBeenCalledWith(failedEnvelope);
    expect(client.getSearchConsoleCredential).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("leaves quota and upstream failures retryable without disabling or ingesting", async () => {
    const error = new SearchConsoleProviderError("quota", {
      retryable: true,
      status: 429,
      retryAfterSeconds: 17,
    });
    const client = ops();
    const checkpoint = {
      load: vi.fn().mockResolvedValue(null),
      assertCapacity: vi.fn(),
      save: vi.fn(),
    };

    await expect(runSearchConsoleSync(input, {
      client,
      checkpoint,
      execute: vi.fn().mockRejectedValue(error),
    })).rejects.toBe(error);

    expect(triggerMocks.warn).toHaveBeenCalledWith(
      "Search Console request will be retried.",
      expect.objectContaining({ retryAfterSeconds: 17, status: 429 }),
    );
    expect(client.reportSearchConsoleAuthenticationFailure).not.toHaveBeenCalled();
    expect(client.uploadArtifact).not.toHaveBeenCalled();
    expect(client.ingest).not.toHaveBeenCalled();
    expect(checkpoint.save).not.toHaveBeenCalled();
  });

  it.each([
    "rateLimitExceededUnreg",
    "userRateLimitExceededUnreg",
    "servingLimitExceeded",
    "concurrentLimitExceeded",
    "limitExceeded",
    "variableTermExpiredDailyExceeded",
    "variableTermLimitExceeded",
  ])("retries documented Google 403 reason %s without disabling the integration", async (reason) => {
    const client = ops();
    const checkpoint = {
      load: vi.fn().mockResolvedValue(null),
      assertCapacity: vi.fn(),
      save: vi.fn(),
    };
    const fetch = vi.fn().mockResolvedValue(Response.json({
      error: { code: 403, message: "Provider limit exceeded", errors: [{ reason }] },
    }, { status: 403 }));

    await expect(runSearchConsoleSync(input, {
      client,
      checkpoint,
      execute: (payload, receivedToken) => executeSearchConsole(payload, {
        client: new SearchConsoleClient({ token: receivedToken, fetch }),
      }),
    })).rejects.toMatchObject({
      name: "SearchConsoleProviderError",
      retryable: true,
      status: 403,
    });

    expect(client.reportSearchConsoleAuthenticationFailure).not.toHaveBeenCalled();
    expect(client.uploadArtifact).not.toHaveBeenCalled();
    expect(client.ingest).not.toHaveBeenCalled();
    expect(checkpoint.save).not.toHaveBeenCalled();
  });

  it("disables credentials for a mixed quota and permission 403", async () => {
    const client = ops();
    const checkpoint = {
      load: vi.fn().mockResolvedValue(null),
      assertCapacity: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
    };
    const fetch = vi.fn().mockResolvedValue(Response.json({
      error: {
        code: 403,
        message: "Mixed denial",
        errors: [{ reason: "quotaExceeded" }, { reason: "insufficientPermissions" }],
      },
    }, { status: 403 }));

    await expect(runSearchConsoleSync(input, {
      client,
      checkpoint,
      execute: (payload, receivedToken) => executeSearchConsole(payload, {
        client: new SearchConsoleClient({ token: receivedToken, fetch }),
      }),
    })).resolves.toMatchObject({
      status: "failed",
      error: { code: "SEARCH_CONSOLE_AUTHENTICATION_FAILED", retryable: false },
    });

    expect(client.reportSearchConsoleAuthenticationFailure).toHaveBeenCalledTimes(1);
    expect(client.ingest).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("disables credentials when Search Console returns an oversized 401 response", async () => {
    const client = ops();
    const checkpoint = {
      load: vi.fn().mockResolvedValue(null),
      assertCapacity: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
    };
    const fetch = vi.fn().mockResolvedValue(new Response("{}", {
      status: 401,
      headers: { "content-length": String(SEARCH_CONSOLE_MAX_RESPONSE_BYTES + 1) },
    }));

    await expect(runSearchConsoleSync(input, {
      client,
      checkpoint,
      execute: (payload, receivedToken) => executeSearchConsole(payload, {
        client: new SearchConsoleClient({ token: receivedToken, fetch }),
      }),
    })).resolves.toMatchObject({
      status: "failed",
      error: { code: "SEARCH_CONSOLE_AUTHENTICATION_FAILED", retryable: false },
    });

    expect(client.reportSearchConsoleAuthenticationFailure).toHaveBeenCalledTimes(1);
    expect(client.ingest).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("turns permanent input, client, and auth outcomes into AbortTaskRunError after safe delivery", async () => {
    const client = ops();
    const checkpoint = {
      load: vi.fn().mockResolvedValue(null),
      assertCapacity: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
    };

    await expect(runSearchConsoleSyncTask({ ...input, token }, { client, checkpoint }))
      .rejects.toMatchObject({ name: "AbortTaskRunError" });
    expect(client.getSearchConsoleCredential).not.toHaveBeenCalled();

    await expect(runSearchConsoleSyncTask(input, {
      client,
      checkpoint,
      execute: vi.fn().mockRejectedValue(new SearchConsoleAuthenticationError(403)),
    })).rejects.toMatchObject({ name: "AbortTaskRunError" });
    expect(client.ingest).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));

    await expect(runSearchConsoleSyncTask(input, {
      client: ops(),
      checkpoint,
      execute: vi.fn().mockRejectedValue(new SearchConsoleProviderError("bad request", {
        retryable: false,
        status: 400,
      })),
    })).rejects.toMatchObject({ name: "AbortTaskRunError" });
  });

  it("enforces the total Trigger metadata cap before artifact upload", async () => {
    const metadataApi = {
      current: vi.fn(() => ({ unrelated: "x".repeat(256 * 1024) })),
      set: vi.fn(),
    };
    const checkpoint = createTriggerMetadataCheckpoint(metadataApi);
    const client = ops();

    await expect(runSearchConsoleSync(input, {
      client,
      checkpoint,
      execute: vi.fn().mockResolvedValue({ envelope, rawReport }),
    })).rejects.toThrow("metadata limit");

    expect(client.uploadArtifact).not.toHaveBeenCalled();
  });

  it("aborts instead of retrying when Trigger metadata cannot hold a delivery checkpoint", async () => {
    const metadataApi = {
      current: vi.fn(() => ({ unrelated: "x".repeat(256 * 1024) })),
      set: vi.fn(),
    };
    const checkpoint = createTriggerMetadataCheckpoint(metadataApi);
    const client = ops();

    await expect(runSearchConsoleSyncTask(input, {
      client,
      checkpoint,
      execute: vi.fn().mockResolvedValue({ envelope, rawReport }),
    })).rejects.toMatchObject({ name: "AbortTaskRunError" });

    expect(client.uploadArtifact).not.toHaveBeenCalled();
  });
});
