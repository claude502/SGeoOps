import { readFile } from "node:fs/promises";

import { analysisEnvelopeSchema, type AnalysisEnvelope } from "@sgeo/analysis-contract";
import { describe, expect, it, vi } from "vitest";

import { MatomoExecutionError, type MatomoInput } from "../adapters/matomo";
import {
  MatomoAuthenticationError,
  MatomoProviderError,
} from "../clients/matomo";
import type { MatomoDeliveryState } from "./matomo-sync";

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
  matomoSyncTask,
  MATOMO_TRIGGER_ENVELOPE_BYTES,
  runMatomoSync,
  runMatomoSyncTask,
} = await import("./matomo-sync");

const input: MatomoInput = {
  runId: "run_1",
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: null,
  integrationId: "integration_1",
  endpoint: "https://analytics.example",
  startDate: "2026-07-01",
  endDate: "2026-07-02",
  idSite: 7,
  segment: "",
  timezone: "UTC",
  idGoal: 1,
  goalName: "lead",
};

const now = "2026-08-03T00:00:00.000Z";
const envelope = analysisEnvelopeSchema.parse({
  contractVersion: "1",
  runId: input.runId,
  clientId: input.clientId,
  brandId: input.brandId,
  siteId: input.siteId,
  siteMarketId: input.siteMarketId,
  source: "matomo",
  sourceVersion: "reporting-api-v5",
  adapterVersion: "1.0.0",
  status: "succeeded",
  startedAt: now,
  finishedAt: now,
  rawArtifact: null,
  observations: [],
  error: null,
});
const token = "matomo-token-never-persist";
const rawReport = new TextEncoder().encode("SGEO-MATOMO-REPORTS-V1\n");

function ops(overrides: Record<string, unknown> = {}) {
  return {
    getMatomoCredential: vi.fn().mockResolvedValue({ token }),
    reportMatomoAuthenticationFailure: vi.fn().mockResolvedValue({
      disabled: true,
      recommendationId: "matomo-auth-1",
    }),
    uploadArtifact: vi.fn().mockResolvedValue({
      uri: `artifact://${input.runId}/matomo-reports-v1.bin`,
      checksum: `sha256:${"a".repeat(64)}`,
      mediaType: "application/vnd.sgeo.matomo-reports.v1",
      byteSize: rawReport.byteLength,
    }),
    ingest: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Matomo sync task", () => {
  it("registers a real bounded Trigger v4 task without Prisma or token payload fields", async () => {
    expect(matomoSyncTask.id).toBe("matomo-sync");
    expect(MATOMO_TRIGGER_ENVELOPE_BYTES).toBe(192 * 1024);
    const [definition] = triggerMocks.task.mock.calls[0] as [Record<string, unknown>];
    expect(definition).toMatchObject({
      id: "matomo-sync",
      queue: { name: "matomo", concurrencyLimit: 2 },
      machine: "medium-1x",
      maxDuration: 900,
      retry: { maxAttempts: 3 },
    });
    const source = await readFile(new URL("./matomo-sync.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/DATABASE_URL|\bPrisma\b|\bprisma\b/);
    expect(source.match(/new MatomoClient/g)).toHaveLength(1);
  });

  it("validates the complete token-free payload before any effects", async () => {
    const client = ops();
    const checkpoint = {
      load: vi.fn(),
      assertCapacity: vi.fn(),
      save: vi.fn(),
    };
    await expect(runMatomoSync({ ...input, token } as never, { client, checkpoint }))
      .rejects.toMatchObject({ name: "MatomoInputError" });
    expect(checkpoint.load).not.toHaveBeenCalled();
    expect(client.getMatomoCredential).not.toHaveBeenCalled();
  });

  it("uploads the artifact before checkpoint and ingest without persisting token or raw bytes", async () => {
    const order: string[] = [];
    const saved: unknown[] = [];
    const client = ops({
      getMatomoCredential: vi.fn(async () => {
        order.push("credential");
        return { token };
      }),
      uploadArtifact: vi.fn(async () => {
        order.push("upload");
        return {
          uri: `artifact://${input.runId}/matomo-reports-v1.bin`,
          checksum: `sha256:${"b".repeat(64)}`,
          mediaType: "application/vnd.sgeo.matomo-reports.v1",
          byteSize: rawReport.byteLength,
        };
      }),
      ingest: vi.fn(async () => { order.push("ingest"); }),
    });
    const checkpoint = {
      load: vi.fn().mockResolvedValue(null),
      assertCapacity: vi.fn(async () => { order.push("capacity"); }),
      save: vi.fn(async (state: unknown) => {
        order.push("checkpoint");
        saved.push(state);
      }),
    };
    const execute = vi.fn(async (_input: MatomoInput, credential: string) => {
      order.push("execute");
      expect(credential).toBe(token);
      return { envelope, rawReport };
    });

    await runMatomoSync({ ...input, endpoint: "https://analytics.example/" }, {
      client,
      checkpoint,
      execute,
    });

    expect(order).toEqual(["credential", "execute", "capacity", "upload", "checkpoint", "ingest"]);
    expect(client.getMatomoCredential).toHaveBeenCalledWith(input.runId, {
      clientId: input.clientId,
      brandId: input.brandId,
      siteId: input.siteId,
      siteMarketId: input.siteMarketId,
      integrationId: input.integrationId,
      endpoint: "https://analytics.example",
    });
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(JSON.stringify(saved)).not.toContain("SGEO-MATOMO");
  });

  it("replays a ready checkpoint so ingest retry does not refetch, requery, or reupload", async () => {
    let saved: MatomoDeliveryState | null = null;
    const checkpoint = {
      load: vi.fn(async () => saved),
      assertCapacity: vi.fn(async () => {}),
      save: vi.fn(async (state: MatomoDeliveryState) => { saved = state; }),
    };
    const ingest = vi.fn()
      .mockRejectedValueOnce(new Error("temporary ingest outage"))
      .mockResolvedValueOnce(undefined);
    const client = ops({ ingest });
    const execute = vi.fn().mockResolvedValue({ envelope, rawReport });
    const dependencies = { client, checkpoint, execute };

    await expect(runMatomoSync(input, dependencies)).rejects.toThrow("temporary ingest outage");
    await expect(runMatomoSync(input, dependencies)).resolves.toEqual(
      expect.objectContaining({ runId: input.runId }),
    );
    expect(client.getMatomoCredential).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(client.uploadArtifact).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(2);
  });

  it("checkpoints authentication failure before disabling exactly its owned integration", async () => {
    const order: string[] = [];
    const client = ops({
      reportMatomoAuthenticationFailure: vi.fn(async () => {
        order.push("disable");
        return { disabled: true, recommendationId: "matomo-auth-1" };
      }),
      ingest: vi.fn(async () => { order.push("ingest"); }),
    });
    const checkpoint = {
      load: vi.fn().mockResolvedValue(null),
      assertCapacity: vi.fn(async () => {}),
      save: vi.fn(async (state: { stage: string }) => { order.push(`checkpoint-${state.stage}`); }),
    };
    const result = await runMatomoSync(input, {
      client,
      checkpoint,
      execute: vi.fn().mockRejectedValue(new MatomoAuthenticationError(403)),
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "MATOMO_AUTHENTICATION_FAILED", retryable: false },
    });
    expect(order).toEqual([
      "checkpoint-auth-failure-pending",
      "disable",
      "checkpoint-ready",
      "ingest",
    ]);
    expect(client.uploadArtifact).not.toHaveBeenCalled();
  });

  it("resumes auth-failure-pending without asking for the disabled credential", async () => {
    const failed: AnalysisEnvelope = {
      ...envelope,
      status: "failed",
      error: {
        code: "MATOMO_AUTHENTICATION_FAILED",
        message: "Matomo credentials were rejected.",
        retryable: false,
      },
    };
    const client = ops();
    const checkpoint = {
      load: vi.fn().mockResolvedValue({ stage: "auth-failure-pending", envelope: failed }),
      assertCapacity: vi.fn(),
      save: vi.fn(),
    };

    await expect(runMatomoSync(input, { client, checkpoint, execute: vi.fn() }))
      .resolves.toEqual(failed);
    expect(client.reportMatomoAuthenticationFailure).toHaveBeenCalledTimes(1);
    expect(client.getMatomoCredential).not.toHaveBeenCalled();
  });

  it("retries only temporary provider failures and safely delivers permanent failures", async () => {
    const temporary = new MatomoProviderError("temporary", { retryable: true, status: 503 });
    const retryClient = ops();
    const checkpoint = { load: vi.fn().mockResolvedValue(null), assertCapacity: vi.fn(), save: vi.fn() };
    await expect(runMatomoSync(input, {
      client: retryClient,
      checkpoint,
      execute: vi.fn().mockRejectedValue(temporary),
    })).rejects.toBe(temporary);
    expect(retryClient.ingest).not.toHaveBeenCalled();
    expect(triggerMocks.warn).toHaveBeenCalledWith(
      "Matomo request will be retried.",
      expect.objectContaining({ runId: input.runId, status: 503 }),
    );

    const permanentClient = ops();
    await expect(runMatomoSync(input, {
      client: permanentClient,
      checkpoint: { load: vi.fn().mockResolvedValue(null), assertCapacity: vi.fn(), save: vi.fn() },
      execute: vi.fn().mockRejectedValue(new MatomoProviderError("bad", {
        retryable: false,
        status: 400,
      })),
    })).resolves.toMatchObject({ status: "failed", error: { code: "MATOMO_REQUEST_REJECTED" } });
    expect(permanentClient.ingest).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("delivers a safe failed envelope when raw report evidence cannot be retained", async () => {
    const client = ops();
    const checkpoint = {
      load: vi.fn().mockResolvedValue(null),
      assertCapacity: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
    };

    await expect(runMatomoSync(input, {
      client,
      checkpoint,
      execute: vi.fn().mockRejectedValue(
        new MatomoExecutionError("Matomo report contains credential material."),
      ),
    })).resolves.toMatchObject({
      status: "failed",
      rawArtifact: null,
      error: { code: "MATOMO_REPORT_REJECTED", retryable: false },
    });
    expect(client.uploadArtifact).not.toHaveBeenCalled();
    expect(client.ingest).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: "MATOMO_REPORT_REJECTED" }),
    }));
  });

  it("enforces the total Trigger metadata cap before artifact upload", async () => {
    const metadataApi = {
      current: vi.fn(() => ({ unrelated: "x".repeat(256 * 1024) })),
      set: vi.fn(),
    };
    const checkpoint = createTriggerMetadataCheckpoint(metadataApi);
    const client = ops();
    await expect(runMatomoSyncTask(input, {
      client,
      checkpoint,
      execute: vi.fn().mockResolvedValue({ envelope, rawReport }),
    })).rejects.toMatchObject({ name: "AbortTaskRunError" });
    expect(client.uploadArtifact).not.toHaveBeenCalled();
  });
});
