import type { AnalysisEnvelope } from "@sgeo/analysis-contract";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { UnlighthouseInput } from "../adapters/unlighthouse";

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
  runUnlighthouseAudit,
  unlighthouseAuditTask,
} = await import("./unlighthouse-audit");

const input: UnlighthouseInput = {
  runId: "run_123",
  clientId: "client_123",
  brandId: "brand_123",
  siteId: "site_123",
  siteMarketId: null,
  url: "https://audit.example/",
  templateRoutes: ["/"],
  timeoutSeconds: 30,
};

const envelope: AnalysisEnvelope = {
  contractVersion: "1",
  runId: input.runId,
  clientId: input.clientId,
  brandId: input.brandId,
  siteId: input.siteId,
  siteMarketId: input.siteMarketId,
  source: "unlighthouse",
  sourceVersion: "0.18.0",
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
    { run: (input: UnlighthouseInput) => Promise<unknown> },
  ];
  return definition.run;
}

function savedCheckpoint() {
  return {
    unlighthouseDeliveryCheckpoint: {
      version: 1,
      envelope: {
        ...envelope,
        rawArtifact: {
          uri: "artifact://run_123/unlighthouse-json-expanded.json",
          checksum: `sha256:${"f".repeat(64)}`,
          mediaType: "application/json",
          byteSize: 32,
        },
      },
    },
  };
}

type InternalTaskEnvironment = {
  baseUrl?: string | null;
  secret?: string;
  secretFile?: string | null;
  useMissingSecretFile?: boolean;
};

async function withInternalTaskEnvironment(
  run: () => Promise<void>,
  options: InternalTaskEnvironment = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "sgeo-unlighthouse-task-"));
  const defaultSecretFile = join(directory, "internal-secret");
  const previousUrl = process.env.SGEO_INTERNAL_URL;
  const previousSecretFile = process.env.SGEO_INTERNAL_SECRET_FILE;
  const baseUrl = options.baseUrl === undefined ? "https://geo-ops.test" : options.baseUrl;
  const secretFile = options.secretFile === undefined
    ? options.useMissingSecretFile
      ? join(directory, "missing-internal-secret")
      : defaultSecretFile
    : options.secretFile;
  await writeFile(defaultSecretFile, options.secret ?? "test-secret\n", { mode: 0o600 });
  if (baseUrl === null) delete process.env.SGEO_INTERNAL_URL;
  else process.env.SGEO_INTERNAL_URL = baseUrl;
  if (secretFile === null) delete process.env.SGEO_INTERNAL_SECRET_FILE;
  else process.env.SGEO_INTERNAL_SECRET_FILE = secretFile;
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

describe("unlighthouseAuditTask", () => {
  it("registers a bounded, payload-driven Trigger v4 browser task", async () => {
    expect(unlighthouseAuditTask.id).toBe("unlighthouse-audit");
    const [definition] = triggerMocks.task.mock.calls[0] as [Record<string, unknown>];

    expect(definition).toMatchObject({
      id: "unlighthouse-audit",
      queue: { name: "unlighthouse", concurrencyLimit: 1 },
      machine: "medium-1x",
      maxDuration: 900,
    });
  });

  it("uploads untouched jsonExpanded bytes before ingesting the linked envelope", async () => {
    const order: string[] = [];
    const rawReport = new TextEncoder().encode('{"routes":[]}\n');
    const uploadArtifact = vi.fn(async () => {
      order.push("upload");
      return {
        uri: "artifact://run_123/unlighthouse-json-expanded.json",
        checksum: `sha256:${"a".repeat(64)}`,
        mediaType: "application/json",
        byteSize: rawReport.byteLength,
      };
    });
    const ingest = vi.fn(async (received: AnalysisEnvelope) => {
      order.push("ingest");
      expect(received.rawArtifact).toEqual({
        uri: "artifact://run_123/unlighthouse-json-expanded.json",
        checksum: `sha256:${"a".repeat(64)}`,
        mediaType: "application/json",
        byteSize: rawReport.byteLength,
      });
    });

    await runUnlighthouseAudit(input, {
      execute: vi.fn(async () => ({ envelope, rawReport })),
      client: { uploadArtifact, ingest },
    });

    expect(order).toEqual(["upload", "ingest"]);
    expect(uploadArtifact).toHaveBeenCalledWith(
      input.runId,
      "unlighthouse-json-expanded.json",
      rawReport,
      "application/json",
    );
  });

  it("checkpoints the uploaded envelope before ingest so an ingest retry neither recrawls nor reuploads", async () => {
    let checkpoint: AnalysisEnvelope | null = null;
    const checkpointStore = {
      load: vi.fn(async () => checkpoint),
      assertCapacity: vi.fn(async () => {}),
      save: vi.fn(async (saved: AnalysisEnvelope) => {
        checkpoint = saved;
      }),
    };
    const rawReport = new TextEncoder().encode('{"routes":[]}\n');
    const execute = vi.fn(async () => ({ envelope, rawReport }));
    const uploadArtifact = vi.fn(async () => ({
      uri: "artifact://run_123/unlighthouse-json-expanded.json",
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

    await expect(runUnlighthouseAudit(input, dependencies)).rejects.toThrow("temporary SGeoOps outage");
    await expect(runUnlighthouseAudit(input, dependencies)).resolves.toEqual(checkpoint);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(uploadArtifact).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(2);
  });

  it("uses a total Trigger metadata cap before artifact upload", async () => {
    const metadataApi = {
      current: vi.fn(() => ({ unrelated: "x".repeat(256 * 1024) })),
      set: vi.fn(),
    };
    const rawReport = new TextEncoder().encode('{"routes":[]}\n');
    const uploadArtifact = vi.fn();
    const checkpoint = createTriggerMetadataCheckpoint(metadataApi);

    await expect(runUnlighthouseAudit(input, {
      execute: vi.fn(async () => ({ envelope, rawReport })),
      client: { uploadArtifact, ingest: vi.fn() },
      checkpoint,
    })).rejects.toThrow("metadata limit");
    expect(uploadArtifact).not.toHaveBeenCalled();
  });

  it("aborts the actual task wrapper for permanent configuration, payload, and SGeoOps failures while retaining transient retries", async () => {
    const taskRun = capturedTaskRun();

    await withInternalTaskEnvironment(async () => {
      await expect(taskRun(input)).rejects.toMatchObject({ name: "AbortTaskRunError" });
    }, { baseUrl: null });

    await withInternalTaskEnvironment(async () => {
      await expect(taskRun(input)).rejects.toMatchObject({ name: "AbortTaskRunError" });
    }, { secretFile: null });

    await withInternalTaskEnvironment(async () => {
      await expect(taskRun(input)).rejects.toMatchObject({ name: "AbortTaskRunError" });
    }, { useMissingSecretFile: true });

    await withInternalTaskEnvironment(async () => {
      await expect(taskRun(input)).rejects.toMatchObject({ name: "AbortTaskRunError" });
    }, { secret: "\n" });

    await withInternalTaskEnvironment(async () => {
      await expect(taskRun({ ...input, templateRoutes: ["https://foreign.example/"] }))
        .rejects.toMatchObject({ name: "AbortTaskRunError" });
    });

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
