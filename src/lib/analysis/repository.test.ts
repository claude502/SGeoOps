import { describe, expect, it, vi } from "vitest";

import type { AnalysisEnvelope } from "@sgeo/analysis-contract";
import {
  AnalysisRepositoryError,
  ingestEnvelope,
  PrismaAnalysisRepository,
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
    status: "queued",
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorSummary: null,
    artifacts: [],
    observations: [],
    ...overrides,
  };
}

function envelopeRunState(
  source: AnalysisEnvelope = envelope,
): Record<string, unknown> {
  return {
    status: source.status,
    startedAt: new Date(source.startedAt),
    finishedAt: source.finishedAt === null
      ? null
      : new Date(source.finishedAt),
    errorCode: source.error?.code ?? null,
    errorSummary: source.error?.message ?? null,
  };
}

function envelopeFacts(source: AnalysisEnvelope = envelope) {
  return {
    artifacts: source.rawArtifact === null
      ? []
      : [{
        uri: source.rawArtifact.uri,
        checksum: source.rawArtifact.checksum,
        mediaType: source.rawArtifact.mediaType,
        byteSize: source.rawArtifact.byteSize,
        sourceVersion: source.sourceVersion,
        retentionAt: new Date("2027-01-27T01:01:00.000Z"),
      }],
    observations: source.observations.map((observation) => ({
      kind: observation.kind,
      subject: observation.subject,
      value: observation.value,
      surface: observation.surface ?? null,
      observedAt: new Date(observation.observedAt),
    })),
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

  it.each([
    ["cross-run", "artifact://run_2/report.json"],
    ["traversal", "artifact://run_1/../report.json"],
    ["encoded traversal", "artifact://run_1/%2e%2e"],
    ["query", "artifact://run_1/report.json?download=1"],
  ])("rejects a %s raw artifact URI without writes", async (_label, uri) => {
    const database = analysisDatabase();

    await expect(
      ingestEnvelope(database as never, {
        ...envelope,
        rawArtifact: { ...envelope.rawArtifact!, uri },
      }),
    ).rejects.toMatchObject({ code: "ANALYSIS_CONTRACT_MISMATCH" });
    expect(database.rawArtifact.create).not.toHaveBeenCalled();
    expect(database.observation.createMany).not.toHaveBeenCalled();
    expect(database.analysisRun.update).not.toHaveBeenCalled();
    expect(database.outboxEvent.create).not.toHaveBeenCalled();
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
        retentionAt: new Date("2027-01-27T01:01:00.000Z"),
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

  it("materializes successful owned SEO output before sealing the ingest marker", async () => {
    const database = analysisDatabase();
    const order: string[] = [];
    const materialize = vi.fn(async () => {
      order.push("materialize");
      return { metrics: 0, recommendations: 0, opportunities: 0 };
    });
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

    await ingestEnvelope(database as never, envelope, undefined, materialize);

    expect(order).toEqual([
      "artifact",
      "observations",
      "run",
      "materialize",
      "marker",
    ]);
    expect(materialize).toHaveBeenCalledWith(database, {
      runId: envelope.runId,
      scope: {
        clientId: envelope.clientId,
        brandId: envelope.brandId,
        siteId: envelope.siteId,
        siteMarketId: envelope.siteMarketId,
      },
    });
  });

  it("does not materialize a successful envelope without a completion time", async () => {
    const database = analysisDatabase();
    const materialize = vi.fn(async () => ({ metrics: 0, recommendations: 0, opportunities: 0 }));

    await ingestEnvelope(database as never, {
      ...envelope,
      finishedAt: null,
    }, undefined, materialize);

    expect(materialize).not.toHaveBeenCalled();
  });

  it("treats an identical marker-backed replay as a no-op", async () => {
    const initial = analysisDatabase();
    await ingestEnvelope(initial as never, envelope);
    const markerPayload = initial.outboxEvent.create.mock.calls[0]?.[0].data.payload;
    const database = analysisDatabase(existingRun({
      ...envelopeRunState(),
      ...envelopeFacts(),
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

  it("repairs complete run state before marking matching recovered facts", async () => {
    const database = analysisDatabase(existingRun({
      ...envelopeFacts(),
      status: "queued",
      startedAt: null,
      finishedAt: null,
      errorCode: "STALE",
      errorSummary: "stale state",
    }));
    const order: string[] = [];
    database.analysisRun.update.mockImplementation(async () => {
      order.push("run");
      return { id: "run_1" };
    });
    database.outboxEvent.create.mockImplementation(async () => {
      order.push("marker");
      return { id: "marker_1" };
    });

    await ingestEnvelope(database as never, envelope);

    expect(order).toEqual(["run", "marker"]);
    expect(database.analysisRun.update).toHaveBeenCalledWith({
      where: { id: "run_1" },
      data: envelopeRunState(),
    });
    expect(database.rawArtifact.create).not.toHaveBeenCalled();
    expect(database.observation.createMany).not.toHaveBeenCalled();
  });

  it("rejects marker-backed replay when sealed run state drifted", async () => {
    const initial = analysisDatabase();
    await ingestEnvelope(initial as never, envelope);
    const markerPayload = initial.outboxEvent.create.mock.calls[0]?.[0].data.payload;
    const database = analysisDatabase(existingRun({
      ...envelopeFacts(),
      status: "queued",
    }));
    database.outboxEvent.findMany.mockResolvedValue([{
      id: "marker_1",
      payload: markerPayload,
    }]);

    await expect(
      ingestEnvelope(database as never, envelope),
    ).rejects.toMatchObject({ code: "ANALYSIS_REPLAY_CONFLICT" });
    expect(database.analysisRun.update).not.toHaveBeenCalled();
    expect(database.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("replays recovered facts after run state and marker are consistent", async () => {
    const initial = analysisDatabase(existingRun({
      ...envelopeFacts(),
    }));
    await ingestEnvelope(initial as never, envelope);
    const markerPayload = initial.outboxEvent.create.mock.calls[0]?.[0].data.payload;
    const database = analysisDatabase(existingRun({
      ...envelopeFacts(),
      ...envelopeRunState(),
    }));
    database.outboxEvent.findMany.mockResolvedValue([{
      id: "marker_1",
      payload: markerPayload,
    }]);

    await ingestEnvelope(database as never, envelope);

    expect(database.analysisRun.update).not.toHaveBeenCalled();
    expect(database.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("reports whether an accepted envelope was already ingested", async () => {
    const initial = analysisDatabase();

    await expect(ingestEnvelope(initial as never, envelope)).resolves.toEqual({
      duplicate: false,
    });
    const markerPayload = initial.outboxEvent.create.mock.calls[0]?.[0].data.payload;
    const replay = analysisDatabase(existingRun({
      ...envelopeFacts(),
      ...envelopeRunState(),
    }));
    replay.outboxEvent.findMany.mockResolvedValue([{
      id: "marker_1",
      payload: markerPayload,
    }]);

    await expect(ingestEnvelope(replay as never, envelope)).resolves.toEqual({
      duplicate: true,
    });
  });

  it("rejects a replay with another artifact checksum", async () => {
    const database = analysisDatabase(existingRun({
      artifacts: [{
        ...envelope.rawArtifact,
        checksum: `sha256:${"b".repeat(64)}`,
        sourceVersion: envelope.sourceVersion,
        retentionAt: new Date("2027-01-27T01:01:00.000Z"),
      }],
    }));

    await expect(
      ingestEnvelope(database as never, envelope),
    ).rejects.toMatchObject({ code: "ANALYSIS_ARTIFACT_CONFLICT" });
  });

  it("checks uploaded artifact metadata inside the ingestion transaction", async () => {
    const database = analysisDatabase();

    await expect(
      ingestEnvelope(database as never, envelope, async () => ({
        ...envelope.rawArtifact!,
        checksum: `sha256:${"b".repeat(64)}`,
      })),
    ).rejects.toMatchObject({ code: "ANALYSIS_ARTIFACT_CONFLICT" });
    expect(database.rawArtifact.create).not.toHaveBeenCalled();
    expect(database.observation.createMany).not.toHaveBeenCalled();
    expect(database.analysisRun.update).not.toHaveBeenCalled();
    expect(database.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("runs uploaded artifact lookup inside Prisma's transaction callback before writes", async () => {
    const transaction = analysisDatabase();
    const order: string[] = [];
    transaction.$queryRaw.mockImplementation(async () => {
      order.push("lock");
      return [];
    });
    transaction.analysisRun.findUnique.mockImplementation(async () => {
      order.push("run");
      return existingRun();
    });
    transaction.rawArtifact.create.mockImplementation(async () => {
      order.push("artifact");
      return { id: "artifact_1" };
    });
    const prisma = {
      $transaction: vi.fn(async (callback) => {
        order.push("transaction");
        return callback(transaction);
      }),
    };
    const repository = new PrismaAnalysisRepository(
      prisma as never,
      async () => {
        order.push("materialize");
        return { metrics: 0, recommendations: 0, opportunities: 0 };
      },
    );

    await repository.ingest(envelope, async () => {
      order.push("metadata");
      return { ...envelope.rawArtifact! };
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(order.indexOf("transaction")).toBeLessThan(order.indexOf("metadata"));
    expect(order.indexOf("run")).toBeLessThan(order.indexOf("metadata"));
    expect(order.indexOf("metadata")).toBeLessThan(order.indexOf("artifact"));
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
      ...envelopeRunState(noArtifact),
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

  it.each(["partial", "retrying"] as const)(
    "persists a bounded non-null error for %s envelopes",
    async (status) => {
      const database = analysisDatabase();
      const withError = {
        ...envelope,
        status,
        error: {
          code: `${status.toUpperCase()}_${"X".repeat(200)}`,
          message: `${status}\n${"detail ".repeat(100)}`,
          retryable: status === "retrying",
        },
      } satisfies AnalysisEnvelope;

      await ingestEnvelope(database as never, withError);

      const update = database.analysisRun.update.mock.calls[0]?.[0].data;
      expect(update.errorCode).toBeTruthy();
      expect(update.errorCode.length).toBeLessThanOrEqual(128);
      expect(update.errorSummary).toBeTruthy();
      expect(update.errorSummary.length).toBeLessThanOrEqual(512);
      expect(update.errorSummary).not.toMatch(/[\n\t]/);
    },
  );

  it("replays an identical partial envelope with error without writes", async () => {
    const partial = {
      ...envelope,
      status: "partial",
      error: {
        code: "PROVIDER_PARTIAL",
        message: "Provider returned incomplete evidence.",
        retryable: true,
      },
    } satisfies AnalysisEnvelope;
    const initial = analysisDatabase();
    await ingestEnvelope(initial as never, partial);
    const markerPayload = initial.outboxEvent.create.mock.calls[0]?.[0].data.payload;
    const database = analysisDatabase(existingRun({
      ...envelopeRunState(partial),
      ...envelopeFacts(partial),
    }));
    database.outboxEvent.findMany.mockResolvedValue([{
      id: "marker_1",
      payload: markerPayload,
    }]);

    await ingestEnvelope(database as never, partial);

    expect(database.analysisRun.update).not.toHaveBeenCalled();
    expect(database.outboxEvent.create).not.toHaveBeenCalled();
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
