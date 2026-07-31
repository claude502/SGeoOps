import { describe, expect, it, vi } from "vitest";

import type { AnalysisEnvelope } from "@sgeo/analysis-contract";
import {
  AnalysisRepositoryError,
  ingestEnvelope,
} from "@/lib/analysis/repository";

const checksum = `sha256:${"a".repeat(64)}`;
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

function existingRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    clientId: "client_1",
    brandId: "brand_1",
    siteId: "site_1",
    siteMarketId: "market_1",
    source: "siteone",
    sourceVersion: "2.0.0",
    adapterVersion: "1.0.0",
    artifacts: [],
    observations: [],
    ...overrides,
  };
}

function analysisDatabase(run = existingRun()) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
    analysisRun: {
      findUnique: vi.fn().mockResolvedValue(run),
      update: vi.fn().mockResolvedValue({ id: "run_1" }),
    },
    rawArtifact: {
      create: vi.fn().mockResolvedValue({ id: "artifact_1" }),
    },
    observation: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    outboxEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: "marker_1" }),
    },
  };
}

describe("ingestEnvelope", () => {
  it("parses the envelope before touching the transaction", async () => {
    const database = analysisDatabase();

    await expect(
      ingestEnvelope(database as never, {
        ...envelope,
        contractVersion: "2",
      } as never),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(database.$queryRaw).not.toHaveBeenCalled();
    expect(database.analysisRun.findUnique).not.toHaveBeenCalled();
  });

  it("locks then queries the run with immutable facts through the supplied tx", async () => {
    const database = analysisDatabase();
    const order: string[] = [];
    database.$queryRaw.mockImplementation(async () => {
      order.push("lock");
      return [];
    });
    database.analysisRun.findUnique.mockImplementation(async () => {
      order.push("find");
      return existingRun();
    });

    await ingestEnvelope(database as never, envelope);

    expect(order.slice(0, 2)).toEqual(["lock", "find"]);
    expect(database.analysisRun.findUnique).toHaveBeenCalledWith({
      where: { id: "run_1" },
      select: expect.objectContaining({
        id: true,
        clientId: true,
        brandId: true,
        siteId: true,
        siteMarketId: true,
        artifacts: expect.any(Object),
        observations: expect.any(Object),
      }),
    });
  });

  it.each([
    ["client", { clientId: "client_2" }],
    ["brand", { brandId: "brand_2" }],
    ["site", { siteId: "site_2" }],
    ["market", { siteMarketId: null }],
  ])("rejects a %s ownership mismatch without writes", async (_label, mismatch) => {
    const database = analysisDatabase(existingRun(mismatch));

    await expect(
      ingestEnvelope(database as never, envelope),
    ).rejects.toMatchObject({ code: "ANALYSIS_OWNERSHIP_MISMATCH" });
    expect(database.rawArtifact.create).not.toHaveBeenCalled();
    expect(database.observation.createMany).not.toHaveBeenCalled();
    expect(database.analysisRun.update).not.toHaveBeenCalled();
    expect(database.outboxEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    ["source", { source: "other" }],
    ["source version", { sourceVersion: "3.0.0" }],
    ["adapter version", { adapterVersion: "2.0.0" }],
  ])("rejects a %s contract mismatch", async (_label, mismatch) => {
    const database = analysisDatabase(existingRun(mismatch));

    await expect(
      ingestEnvelope(database as never, envelope),
    ).rejects.toMatchObject({ code: "ANALYSIS_CONTRACT_MISMATCH" });
    expect(database.rawArtifact.create).not.toHaveBeenCalled();
  });

  it("persists immutable evidence and updates the run in call order", async () => {
    const database = analysisDatabase();
    const order: string[] = [];
    database.rawArtifact.create.mockImplementation(async () => {
      order.push("artifact");
      return { id: "artifact_1" };
    });
    database.observation.createMany.mockImplementation(async () => {
      order.push("observations");
      return { count: 1 };
    });
    database.analysisRun.update.mockImplementation(async () => {
      order.push("run");
      return { id: "run_1" };
    });
    database.outboxEvent.create.mockImplementation(async () => {
      order.push("marker");
      return { id: "marker_1" };
    });

    await ingestEnvelope(database as never, envelope);

    expect(order).toEqual(["artifact", "observations", "run", "marker"]);
    expect(database.rawArtifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: "run_1",
        uri: "artifact://run_1/report.json",
        checksum,
        mediaType: "application/json",
        byteSize: 42,
        sourceVersion: "2.0.0",
        retentionAt: new Date("2026-10-29T01:01:00.000Z"),
      }),
    });
    expect(database.observation.createMany).toHaveBeenCalledWith({
      data: [{
        runId: "run_1",
        kind: "http_status",
        subject: "https://example.com/",
        value: { status: 200 },
        surface: "api",
        observedAt: new Date("2026-07-31T01:00:30.000Z"),
      }],
    });
    expect(database.analysisRun.update).toHaveBeenCalledWith({
      where: { id: "run_1" },
      data: {
        status: "succeeded",
        startedAt: new Date("2026-07-31T01:00:00.000Z"),
        finishedAt: new Date("2026-07-31T01:01:00.000Z"),
        errorCode: null,
        errorSummary: null,
      },
    });
    expect(database.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: "AnalysisRunIngest",
        aggregateId: "run_1",
        eventType: "analysis_run.ingested",
        payload: expect.objectContaining({
          contractVersion: "1",
          envelopeHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
      }),
    });
  });

  it("treats an identical marker-backed replay as a no-op", async () => {
    const initial = analysisDatabase();
    await ingestEnvelope(initial as never, envelope);
    const markerPayload = initial.outboxEvent.create.mock.calls[0]?.[0].data.payload;
    const database = analysisDatabase(existingRun({
      artifacts: [{
        uri: envelope.rawArtifact!.uri,
        checksum: envelope.rawArtifact!.checksum,
        mediaType: envelope.rawArtifact!.mediaType,
        byteSize: envelope.rawArtifact!.byteSize,
        sourceVersion: envelope.sourceVersion,
        retentionAt: new Date("2026-10-29T01:01:00.000Z"),
      }],
      observations: [{
        kind: "http_status",
        subject: "https://example.com/",
        value: { status: 200 },
        surface: "api",
        observedAt: new Date("2026-07-31T01:00:30.000Z"),
      }],
    }));
    database.outboxEvent.findMany.mockResolvedValue([{
      id: "marker_1",
      payload: markerPayload,
    }]);

    await ingestEnvelope(database as never, envelope);

    expect(database.rawArtifact.create).not.toHaveBeenCalled();
    expect(database.observation.createMany).not.toHaveBeenCalled();
    expect(database.analysisRun.update).not.toHaveBeenCalled();
    expect(database.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a replay with another artifact checksum", async () => {
    const database = analysisDatabase(existingRun({
      artifacts: [{
        ...envelope.rawArtifact,
        checksum: `sha256:${"b".repeat(64)}`,
        sourceVersion: envelope.sourceVersion,
        retentionAt: new Date("2026-10-29T01:01:00.000Z"),
      }],
    }));

    await expect(
      ingestEnvelope(database as never, envelope),
    ).rejects.toMatchObject({ code: "ANALYSIS_ARTIFACT_CONFLICT" });
  });

  it("uses a stable marker for a null-artifact replay", async () => {
    const noArtifact = {
      ...envelope,
      rawArtifact: null,
    } satisfies AnalysisEnvelope;
    const initial = analysisDatabase();
    await ingestEnvelope(initial as never, noArtifact);
    const markerPayload = initial.outboxEvent.create.mock.calls[0]?.[0].data.payload;
    const database = analysisDatabase(existingRun({
      observations: [{
        kind: "http_status",
        subject: "https://example.com/",
        value: { status: 200 },
        surface: "api",
        observedAt: new Date("2026-07-31T01:00:30.000Z"),
      }],
    }));
    database.outboxEvent.findMany.mockResolvedValue([{
      id: "marker_1",
      payload: markerPayload,
    }]);

    await ingestEnvelope(database as never, noArtifact);

    expect(database.observation.createMany).not.toHaveBeenCalled();
    expect(database.analysisRun.update).not.toHaveBeenCalled();
  });

  it("propagates a middle write failure for transaction rollback", async () => {
    const database = analysisDatabase();
    database.observation.createMany.mockRejectedValue(
      new Error("observation failed"),
    );

    await expect(
      ingestEnvelope(database as never, envelope),
    ).rejects.toThrow("observation failed");
    expect(database.rawArtifact.create).toHaveBeenCalledOnce();
    expect(database.analysisRun.update).not.toHaveBeenCalled();
    expect(database.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("maps failed envelopes to bounded safe error fields", async () => {
    const database = analysisDatabase();
    const failed = {
      ...envelope,
      status: "failed",
      error: {
        code: `PROVIDER_${"X".repeat(200)}`,
        message: `Provider\nfailed\t${"detail ".repeat(100)}`,
        retryable: true,
      },
    } satisfies AnalysisEnvelope;

    await ingestEnvelope(database as never, failed);

    const update = database.analysisRun.update.mock.calls[0]?.[0].data;
    expect(update.errorCode.length).toBeLessThanOrEqual(128);
    expect(update.errorSummary.length).toBeLessThanOrEqual(512);
    expect(update.errorSummary).not.toMatch(/[\n\t]/);
  });

  it("uses stable repository error instances", () => {
    expect(
      new AnalysisRepositoryError("ANALYSIS_RUN_NOT_FOUND"),
    ).toMatchObject({
      name: "AnalysisRepositoryError",
      code: "ANALYSIS_RUN_NOT_FOUND",
    });
  });
});
