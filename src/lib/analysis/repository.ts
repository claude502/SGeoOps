import { createHash } from "node:crypto";
import type { Prisma, RunStatus } from "@prisma/client";
import {
  analysisEnvelopeSchema,
  type AnalysisEnvelope,
} from "@sgeo/analysis-contract";

import {
  createOutboxEvent,
  type CreateOutboxEvent,
} from "@/lib/events/outbox";
import {
  ArtifactUriError,
  parseArtifactUri,
} from "@/lib/artifacts/uri";

export type { CreateOutboxEvent } from "@/lib/events/outbox";

export const RAW_ARTIFACT_RETENTION_DAYS = 180;
const retentionMilliseconds =
  RAW_ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const ingestAggregateType = "AnalysisRunIngest";
const ingestEventType = "analysis_run.ingested";

export type AnalysisRepositoryErrorCode =
  | "ANALYSIS_RUN_NOT_FOUND"
  | "ANALYSIS_OWNERSHIP_MISMATCH"
  | "ANALYSIS_CONTRACT_MISMATCH"
  | "ANALYSIS_ARTIFACT_CONFLICT"
  | "ANALYSIS_REPLAY_CONFLICT";

export class AnalysisRepositoryError extends Error {
  constructor(
    readonly code: AnalysisRepositoryErrorCode,
    message: string = code,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AnalysisRepositoryError";
  }
}

export interface CreateAnalysisRun {
  id: string;
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
  kind: string;
  source: string;
  sourceVersion: string;
  adapterVersion: string;
  status: RunStatus;
  inputHash: string;
  idempotencyKey: string;
  trigger: string;
  attemptCount?: number;
  errorCode?: string | null;
  errorSummary?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

export async function createRunWithOutbox(
  tx: Prisma.TransactionClient,
  run: CreateAnalysisRun,
  event: CreateOutboxEvent,
): Promise<void> {
  await tx.analysisRun.create({ data: run });
  await createOutboxEvent(tx, event);
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

function envelopeHash(envelope: AnalysisEnvelope) {
  const body = canonicalJson(envelope as unknown as JsonValue);
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function safeErrorText(value: string, maximumLength: number) {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ")
    .trim().slice(0, maximumLength);
}

function expectedRunState(envelope: AnalysisEnvelope) {
  const persistedError = envelope.error;
  return {
    status: envelope.status,
    startedAt: new Date(envelope.startedAt),
    finishedAt: envelope.finishedAt === null
      ? null
      : new Date(envelope.finishedAt),
    errorCode: persistedError === null
      ? null
      : safeErrorText(persistedError.code, 128),
    errorSummary: persistedError === null
      ? null
      : safeErrorText(persistedError.message, 512),
  };
}

function assertRunState(
  run: {
    status: RunStatus;
    startedAt: Date | null;
    finishedAt: Date | null;
    errorCode: string | null;
    errorSummary: string | null;
  },
  envelope: AnalysisEnvelope,
) {
  const expected = expectedRunState(envelope);
  if (
    run.status !== expected.status ||
    run.startedAt?.getTime() !== expected.startedAt.getTime() ||
    run.finishedAt?.getTime() !== expected.finishedAt?.getTime() ||
    run.errorCode !== expected.errorCode ||
    run.errorSummary !== expected.errorSummary
  ) {
    throw new AnalysisRepositoryError(
      "ANALYSIS_REPLAY_CONFLICT",
      "Analysis run state differs from the accepted replay.",
    );
  }
}

function observationSignature(observation: {
  kind: string;
  subject: string;
  value: unknown;
  surface?: string | null;
  observedAt: string | Date;
}) {
  const observedAt = observation.observedAt instanceof Date
    ? observation.observedAt.toISOString()
    : new Date(observation.observedAt).toISOString();
  return canonicalJson({
    kind: observation.kind,
    subject: observation.subject,
    value: observation.value as JsonValue,
    surface: observation.surface ?? null,
    observedAt,
  });
}

function expectedRetentionAt(envelope: AnalysisEnvelope) {
  const base = new Date(envelope.finishedAt ?? envelope.startedAt);
  return new Date(base.getTime() + retentionMilliseconds);
}

function markerEnvelopeHash(payload: Prisma.JsonValue) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const contractVersion = payload.contractVersion;
  const hash = payload.envelopeHash;
  return (
      contractVersion === "1" &&
      typeof hash === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(hash)
    )
    ? hash
    : null;
}

function assertArtifactFacts(
  artifacts: Array<{
    uri: string;
    checksum: string;
    mediaType: string;
    byteSize: number;
    sourceVersion: string;
    retentionAt: Date;
  }>,
  envelope: AnalysisEnvelope,
) {
  const expected = envelope.rawArtifact;
  if (expected === null) {
    if (artifacts.length !== 0) {
      throw new AnalysisRepositoryError(
        "ANALYSIS_ARTIFACT_CONFLICT",
        "Analysis replay changed the raw artifact.",
      );
    }
    return;
  }
  if (
    artifacts.length !== 1 ||
    artifacts[0].checksum !== expected.checksum
  ) {
    throw new AnalysisRepositoryError(
      "ANALYSIS_ARTIFACT_CONFLICT",
      "Analysis replay changed the raw artifact checksum.",
    );
  }
  const artifact = artifacts[0];
  const retentionAt = expectedRetentionAt(envelope);
  if (
    artifact.uri !== expected.uri ||
    artifact.mediaType !== expected.mediaType ||
    artifact.byteSize !== expected.byteSize ||
    artifact.sourceVersion !== envelope.sourceVersion ||
    artifact.retentionAt.getTime() !== retentionAt.getTime()
  ) {
    throw new AnalysisRepositoryError(
      "ANALYSIS_ARTIFACT_CONFLICT",
      "Analysis replay changed immutable artifact metadata.",
    );
  }
}

function assertObservationFacts(
  observations: Array<{
    kind: string;
    subject: string;
    value: Prisma.JsonValue;
    surface: string | null;
    observedAt: Date;
  }>,
  envelope: AnalysisEnvelope,
) {
  const stored = observations.map(observationSignature).sort();
  const expected = envelope.observations.map(observationSignature).sort();
  if (
    stored.length !== expected.length ||
    stored.some((signature, index) => signature !== expected[index])
  ) {
    throw new AnalysisRepositoryError(
      "ANALYSIS_REPLAY_CONFLICT",
      "Analysis replay changed immutable observations.",
    );
  }
}

async function createIngestMarker(
  tx: Prisma.TransactionClient,
  runId: string,
  hash: string,
) {
  await createOutboxEvent(tx, {
    aggregateType: ingestAggregateType,
    aggregateId: runId,
    eventType: ingestEventType,
    payload: {
      contractVersion: "1",
      envelopeHash: hash,
    },
  });
}

export async function ingestEnvelope(
  tx: Prisma.TransactionClient,
  envelope: AnalysisEnvelope,
): Promise<void> {
  const parsed = analysisEnvelopeSchema.parse(envelope);
  if (parsed.rawArtifact !== null) {
    try {
      const location = parseArtifactUri(parsed.rawArtifact.uri);
      if (location.runId !== parsed.runId) {
        throw new ArtifactUriError(
          "Raw artifact URI does not belong to the analysis run.",
        );
      }
    } catch (error) {
      if (error instanceof ArtifactUriError) {
        throw new AnalysisRepositoryError(
          "ANALYSIS_CONTRACT_MISMATCH",
          "Analysis raw artifact URI is invalid or belongs to another run.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  await tx.$queryRaw`
    WITH acquired AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${parsed.runId}, 7188::bigint)
      )
    )
    SELECT true AS locked FROM acquired
  `;
  const run = await tx.analysisRun.findUnique({
    where: { id: parsed.runId },
    select: {
      id: true,
      clientId: true,
      brandId: true,
      siteId: true,
      siteMarketId: true,
      source: true,
      sourceVersion: true,
      adapterVersion: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      errorCode: true,
      errorSummary: true,
      artifacts: {
        select: {
          uri: true,
          checksum: true,
          mediaType: true,
          byteSize: true,
          sourceVersion: true,
          retentionAt: true,
        },
        orderBy: { id: "asc" },
      },
      observations: {
        select: {
          kind: true,
          subject: true,
          value: true,
          surface: true,
          observedAt: true,
        },
        orderBy: { id: "asc" },
      },
    },
  });
  if (!run) {
    throw new AnalysisRepositoryError(
      "ANALYSIS_RUN_NOT_FOUND",
      "Analysis run does not exist.",
    );
  }

  if (
    run.clientId !== parsed.clientId ||
    run.brandId !== parsed.brandId ||
    run.siteId !== parsed.siteId ||
    run.siteMarketId !== parsed.siteMarketId
  ) {
    throw new AnalysisRepositoryError(
      "ANALYSIS_OWNERSHIP_MISMATCH",
      "Analysis envelope ownership does not match the run.",
    );
  }
  if (
    run.source !== parsed.source ||
    run.sourceVersion !== parsed.sourceVersion ||
    run.adapterVersion !== parsed.adapterVersion
  ) {
    throw new AnalysisRepositoryError(
      "ANALYSIS_CONTRACT_MISMATCH",
      "Analysis envelope source contract does not match the run.",
    );
  }

  const hash = envelopeHash(parsed);
  const markers = await tx.outboxEvent.findMany({
    where: {
      aggregateType: ingestAggregateType,
      aggregateId: parsed.runId,
      eventType: ingestEventType,
    },
    select: { id: true, payload: true },
    orderBy: { createdAt: "asc" },
    take: 2,
  });
  if (markers.length > 1) {
    throw new AnalysisRepositoryError(
      "ANALYSIS_REPLAY_CONFLICT",
      "Analysis run has multiple ingestion markers.",
    );
  }
  if (markers.length === 1) {
    assertArtifactFacts(run.artifacts, parsed);
    assertObservationFacts(run.observations, parsed);
    if (markerEnvelopeHash(markers[0].payload) !== hash) {
      throw new AnalysisRepositoryError(
        "ANALYSIS_REPLAY_CONFLICT",
        "Analysis envelope differs from the accepted replay.",
      );
    }
    assertRunState(run, parsed);
    return;
  }

  const hasImmutableFacts =
    run.artifacts.length > 0 || run.observations.length > 0;
  if (hasImmutableFacts) {
    assertArtifactFacts(run.artifacts, parsed);
    assertObservationFacts(run.observations, parsed);
    await tx.analysisRun.update({
      where: { id: parsed.runId },
      data: expectedRunState(parsed),
    });
    await createIngestMarker(tx, parsed.runId, hash);
    return;
  }

  if (parsed.rawArtifact !== null) {
    await tx.rawArtifact.create({
      data: {
        runId: parsed.runId,
        uri: parsed.rawArtifact.uri,
        checksum: parsed.rawArtifact.checksum,
        mediaType: parsed.rawArtifact.mediaType,
        byteSize: parsed.rawArtifact.byteSize,
        sourceVersion: parsed.sourceVersion,
        retentionAt: expectedRetentionAt(parsed),
      },
    });
  }
  if (parsed.observations.length > 0) {
    await tx.observation.createMany({
      data: parsed.observations.map((observation) => ({
        runId: parsed.runId,
        kind: observation.kind,
        subject: observation.subject,
        value: observation.value as Prisma.InputJsonValue,
        surface: observation.surface ?? null,
        observedAt: new Date(observation.observedAt),
      })),
    });
  }

  await tx.analysisRun.update({
    where: { id: parsed.runId },
    data: expectedRunState(parsed),
  });
  await createIngestMarker(tx, parsed.runId, hash);
}
