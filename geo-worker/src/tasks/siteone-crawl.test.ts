import type { AnalysisEnvelope } from "@sgeo/analysis-contract";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { SiteOneInput } from "../adapters/siteone";

const triggerMocks = vi.hoisted(() => ({
  task: vi.fn((definition: { id: string; run: (input: unknown) => Promise<unknown> }) => ({
    id: definition.id,
    run: definition.run,
  })),
  info: vi.fn(),
  warn: vi.fn(),
  metadata: {
    current: vi.fn(),
    set: vi.fn(),
    flush: vi.fn(),
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
  logger: { info: triggerMocks.info, warn: triggerMocks.warn },
  metadata: triggerMocks.metadata,
  AbortTaskRunError: triggerMocks.AbortTaskRunError,
}));

const {
  createTriggerMetadataCheckpoint,
  runSiteOneCrawl,
  siteOneCrawlTask,
} = await import("./siteone-crawl");

const input = {
  runId: "run_123",
  clientId: "client_123",
  brandId: "brand_123",
  siteId: "site_123",
  siteMarketId: null,
  url: "https://example.test/",
  maxUrls: 25,
  timeoutSeconds: 30,
};

const envelope: AnalysisEnvelope = {
  contractVersion: "1",
  runId: input.runId,
  clientId: input.clientId,
  brandId: input.brandId,
  siteId: input.siteId,
  siteMarketId: input.siteMarketId,
  source: "siteone",
  sourceVersion: "2.5.1",
  adapterVersion: "1.0.0",
  status: "succeeded",
  startedAt: "2026-08-01T00:00:00.000Z",
  finishedAt: "2026-08-01T00:00:01.000Z",
  rawArtifact: null,
  observations: [],
  error: null,
};

function capturedTaskRun() {
  const [definition] = triggerMocks.task.mock.calls[0] as [
    { run: (input: SiteOneInput) => Promise<unknown> },
  ];
  return definition.run;
}

function savedCheckpoint() {
  return {
    siteoneDeliveryCheckpoint: {
      version: 1,
      envelope: {
        ...envelope,
        rawArtifact: {
          uri: "artifact://run_123/siteone-report.json",
          checksum: `sha256:${"e".repeat(64)}`,
          mediaType: "application/json",
          byteSize: 27,
        },
      },
    },
  };
}

async function withInternalTaskEnvironment(run: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "sgeo-siteone-task-"));
  const secretFile = join(directory, "internal-secret");
  const previousUrl = process.env.SGEO_INTERNAL_URL;
  const previousSecretFile = process.env.SGEO_INTERNAL_SECRET_FILE;
  await writeFile(secretFile, "test-secret\n", { mode: 0o600 });
  process.env.SGEO_INTERNAL_URL = "https://geo-ops.test";
  process.env.SGEO_INTERNAL_SECRET_FILE = secretFile;
  try {
    await run();
  } finally {
    if (previousUrl === undefined) delete process.env.SGEO_INTERNAL_URL;
    else process.env.SGEO_INTERNAL_URL = previousUrl;
    if (previousSecretFile === undefined) delete process.env.SGEO_INTERNAL_SECRET_FILE;
    else process.env.SGEO_INTERNAL_SECRET_FILE = previousSecretFile;
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("siteOneCrawlTask", () => {
  it("registers a bounded Trigger v4 task", () => {
    expect(siteOneCrawlTask.id).toBe("siteone-crawl");
    const [definition] = triggerMocks.task.mock.calls[0] as [
      Record<string, unknown>,
    ];

    expect(definition).toMatchObject({
      id: "siteone-crawl",
      queue: { name: "siteone", concurrencyLimit: 2 },
      machine: "medium-1x",
      maxDuration: 900,
    });
  });

  it("uploads the untouched report before ingesting an envelope linked to its metadata", async () => {
    const order: string[] = [];
    const rawReport = new TextEncoder().encode('{"crawler":"siteone"}\n');
    const uploadArtifact = vi.fn(async () => {
      order.push("upload");
      return {
        uri: "artifact://run_123/siteone-report.json",
        checksum: `sha256:${"a".repeat(64)}`,
        mediaType: "application/json",
        byteSize: rawReport.byteLength,
      };
    });
    const ingest = vi.fn(async (received: AnalysisEnvelope) => {
      order.push("ingest");
      expect(received.rawArtifact).toEqual({
        uri: "artifact://run_123/siteone-report.json",
        checksum: `sha256:${"a".repeat(64)}`,
        mediaType: "application/json",
        byteSize: rawReport.byteLength,
      });
    });

    const result = await runSiteOneCrawl(input, {
      execute: vi.fn(async () => ({ envelope, rawReport })),
      client: { uploadArtifact, ingest },
    });

    expect(order).toEqual(["upload", "ingest"]);
    expect(uploadArtifact).toHaveBeenCalledWith(
      input.runId,
      "siteone-report.json",
      rawReport,
      "application/json",
    );
    expect(result.rawArtifact).not.toBeNull();
  });

  it("checkpoints a validated uploaded envelope before ingestion so a retry does not recrawl or re-upload", async () => {
    let checkpoint: AnalysisEnvelope | null = null;
    const checkpointStore = {
      load: vi.fn(async () => checkpoint),
      assertCapacity: vi.fn(async () => {}),
      save: vi.fn(async (saved: AnalysisEnvelope) => {
        checkpoint = saved;
      }),
    };
    const rawReport = new TextEncoder().encode('{"crawler":"siteone"}\n');
    const execute = vi.fn(async () => ({ envelope, rawReport }));
    const uploadArtifact = vi.fn(async () => ({
      uri: "artifact://run_123/siteone-report.json",
      checksum: `sha256:${"b".repeat(64)}`,
      mediaType: "application/json",
      byteSize: rawReport.byteLength,
    }));
    const ingest = vi.fn()
      .mockRejectedValueOnce(new Error("temporary SGeoOps outage"))
      .mockResolvedValueOnce(undefined);
    const dependencies = {
      execute,
      client: { uploadArtifact, ingest },
      checkpoint: checkpointStore,
    };

    await expect(runSiteOneCrawl(input, dependencies)).rejects.toThrow("temporary SGeoOps outage");
    expect(checkpointStore.save).toHaveBeenCalledTimes(1);
    const savedCheckpoint = checkpointStore.save.mock.calls[0]?.[0];
    expect(savedCheckpoint?.rawArtifact).toEqual({
      uri: "artifact://run_123/siteone-report.json",
      checksum: `sha256:${"b".repeat(64)}`,
      mediaType: "application/json",
      byteSize: rawReport.byteLength,
    });

    const retried = await runSiteOneCrawl(input, dependencies);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(uploadArtifact).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(retried).toEqual(savedCheckpoint);
    expect(ingest).toHaveBeenLastCalledWith(savedCheckpoint);
  });

  it("persists and flushes Trigger metadata checkpoints only after validating the envelope", async () => {
    const state: Record<string, unknown> = { unrelated: "preserve-me" };
    triggerMocks.metadata.current.mockReturnValue(state);
    triggerMocks.metadata.flush.mockResolvedValue(undefined);
    triggerMocks.metadata.set.mockImplementation((key: string, value: unknown) => {
      state[key] = value;
      return { flush: triggerMocks.metadata.flush };
    });
    const checkpoint = createTriggerMetadataCheckpoint();
    const saved = {
      ...envelope,
      rawArtifact: {
        uri: "artifact://run_123/siteone-report.json",
        checksum: `sha256:${"c".repeat(64)}`,
        mediaType: "application/json",
        byteSize: 27,
      },
    };

    await checkpoint.save(saved);

    expect(triggerMocks.metadata.set).toHaveBeenCalledWith(
      "siteoneDeliveryCheckpoint",
      expect.objectContaining({ version: 1, envelope: saved }),
    );
    expect(triggerMocks.metadata.flush).toHaveBeenCalledTimes(1);
    await expect(checkpoint.load(input)).resolves.toEqual(saved);
    expect(state.unrelated).toBe("preserve-me");
  });

  it("rejects oversized total Trigger metadata before publishing an artifact", async () => {
    const metadataApi = {
      current: vi.fn(() => ({ unrelated: "x".repeat(256 * 1024) })),
      set: vi.fn(),
    };
    const rawReport = new TextEncoder().encode('{"crawler":"siteone"}\n');
    const uploadArtifact = vi.fn(async () => ({
      uri: "artifact://run_123/siteone-report.json",
      checksum: `sha256:${"d".repeat(64)}`,
      mediaType: "application/json",
      byteSize: rawReport.byteLength,
    }));
    const checkpoint = createTriggerMetadataCheckpoint(metadataApi);

    await expect(runSiteOneCrawl(input, {
      execute: vi.fn(async () => ({ envelope, rawReport })),
      client: { uploadArtifact, ingest: vi.fn() },
      checkpoint,
    })).rejects.toThrow("metadata limit");

    expect(uploadArtifact).not.toHaveBeenCalled();
    expect(metadataApi.set).not.toHaveBeenCalled();
  });

  it("aborts the captured Trigger task run for a permanent SGeoOps client failure but retries a transient one", async () => {
    const taskRun = capturedTaskRun();

    await withInternalTaskEnvironment(async () => {
      triggerMocks.metadata.current.mockReturnValue(savedCheckpoint());
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));

      await expect(taskRun(input)).rejects.toMatchObject({ name: "AbortTaskRunError" });
    });

    await withInternalTaskEnvironment(async () => {
      triggerMocks.metadata.current.mockReturnValue(savedCheckpoint());
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

      await expect(taskRun(input)).rejects.toMatchObject({
        name: "SgeoOpsClientError",
        retryable: true,
      });
    });
  });
});
