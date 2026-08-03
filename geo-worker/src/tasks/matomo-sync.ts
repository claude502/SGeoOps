import { createHash } from "node:crypto";

import { analysisEnvelopeSchema, type AnalysisEnvelope } from "@sgeo/analysis-contract";
import { AbortTaskRunError, logger, metadata, task } from "@trigger.dev/sdk";

import {
  executeMatomo,
  MATOMO_ARTIFACT_MEDIA_TYPE,
  MATOMO_ARTIFACT_NAME,
  MATOMO_MAX_RAW_BYTES,
  MatomoExecutionError,
  MatomoInputError,
  parseMatomoInput,
  type MatomoExecution,
  type MatomoInput,
} from "../adapters/matomo";
import {
  MatomoAuthenticationError,
  MatomoClient,
  MatomoProviderError,
} from "../clients/matomo";
import {
  SgeoOpsClient,
  SgeoOpsClientError,
  type MatomoControlScope,
} from "../clients/sgeo-ops";
import { InternalSgeoAuthError, readInternalSgeoSecret } from "./internal-sgeo-auth";

export const MATOMO_TRIGGER_ENVELOPE_BYTES = 192 * 1024;
const MATOMO_DELIVERY_CHECKPOINT_KEY = "matomoDeliveryCheckpoint";
const TRIGGER_METADATA_MAX_BYTES = 256 * 1024;

type MatomoOpsClient = Pick<
  SgeoOpsClient,
  | "getMatomoCredential"
  | "reportMatomoAuthenticationFailure"
  | "uploadArtifact"
  | "reconcileArtifact"
  | "ingest"
>;

export type MatomoDeliveryState = {
  stage: "artifact-pending" | "auth-failure-pending" | "ready";
  envelope: AnalysisEnvelope;
};

export interface MatomoCheckpoint {
  load(input: MatomoInput): Promise<MatomoDeliveryState | null>;
  assertCapacity(state: MatomoDeliveryState): Promise<void>;
  save(state: MatomoDeliveryState): Promise<void>;
}

export type MatomoSyncDependencies = {
  client?: MatomoOpsClient;
  checkpoint?: MatomoCheckpoint;
  execute?: (input: MatomoInput, token: string) => Promise<MatomoExecution>;
};

export type MatomoTriggerMetadata = {
  current(): Record<string, unknown> | undefined;
  set(key: string, value: unknown): { flush(): Promise<void> };
};

export class MatomoTaskConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatomoTaskConfigurationError";
  }
}

function internalOrigin(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MatomoTaskConfigurationError("SGEO_INTERNAL_URL must be an HTTP(S) origin.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new MatomoTaskConfigurationError(
      "SGEO_INTERNAL_URL must be an HTTP(S) origin without credentials, path, query, or fragment.",
    );
  }
  return parsed.origin;
}

export async function createDefaultMatomoOpsClient() {
  const configuredBaseUrl = process.env.SGEO_INTERNAL_URL;
  if (!configuredBaseUrl) {
    throw new MatomoTaskConfigurationError("SGEO_INTERNAL_URL is required.");
  }
  const baseUrl = internalOrigin(configuredBaseUrl);
  let secret: string;
  try {
    secret = await readInternalSgeoSecret();
  } catch (error) {
    throw new MatomoTaskConfigurationError(
      error instanceof InternalSgeoAuthError ? error.message : "SGeoOps internal secret is invalid.",
    );
  }
  return new SgeoOpsClient({ baseUrl, secret });
}

function controlScope(input: MatomoInput): MatomoControlScope {
  return {
    clientId: input.clientId,
    brandId: input.brandId,
    siteId: input.siteId,
    siteMarketId: input.siteMarketId,
    integrationId: input.integrationId,
    endpoint: input.endpoint,
  };
}

function validateCheckpointState(
  value: unknown,
  input?: MatomoInput,
): MatomoDeliveryState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MatomoTaskConfigurationError("Matomo delivery checkpoint is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\u0000") !== "envelope\u0000stage" ||
    (
      record.stage !== "artifact-pending" &&
      record.stage !== "auth-failure-pending" &&
      record.stage !== "ready"
    )
  ) {
    throw new MatomoTaskConfigurationError("Matomo delivery checkpoint is invalid.");
  }
  const envelope = analysisEnvelopeSchema.safeParse(record.envelope);
  if (!envelope.success || envelope.data.source !== "matomo") {
    throw new MatomoTaskConfigurationError("Matomo delivery checkpoint is invalid.");
  }
  if (
    input !== undefined &&
    (
      envelope.data.runId !== input.runId ||
      envelope.data.clientId !== input.clientId ||
      envelope.data.brandId !== input.brandId ||
      envelope.data.siteId !== input.siteId ||
      envelope.data.siteMarketId !== input.siteMarketId
    )
  ) {
    throw new MatomoTaskConfigurationError(
      "Matomo delivery checkpoint does not match the task payload.",
    );
  }
  if (
    record.stage === "auth-failure-pending" &&
    envelope.data.error?.code !== "MATOMO_AUTHENTICATION_FAILED"
  ) {
    throw new MatomoTaskConfigurationError("Matomo authentication checkpoint is invalid.");
  }
  if (
    record.stage === "artifact-pending" &&
    (
      envelope.data.rawArtifact === null ||
      envelope.data.rawArtifact.uri !== `artifact://${envelope.data.runId}/${MATOMO_ARTIFACT_NAME}` ||
      envelope.data.rawArtifact.mediaType !== MATOMO_ARTIFACT_MEDIA_TYPE ||
      envelope.data.rawArtifact.byteSize > MATOMO_MAX_RAW_BYTES
    )
  ) {
    throw new MatomoTaskConfigurationError("Matomo artifact checkpoint is invalid.");
  }
  return { stage: record.stage, envelope: envelope.data };
}

function checkpointRecord(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MatomoTaskConfigurationError("Matomo delivery checkpoint is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\u0000") !== "state\u0000version" ||
    record.version !== 1
  ) {
    throw new MatomoTaskConfigurationError("Matomo delivery checkpoint is invalid.");
  }
  return record.state;
}

function projectedMetadata(
  state: MatomoDeliveryState,
  currentMetadata: Record<string, unknown> | undefined,
) {
  const checked = validateCheckpointState(state);
  let serialized: string;
  try {
    serialized = JSON.stringify({
      ...(currentMetadata ?? {}),
      [MATOMO_DELIVERY_CHECKPOINT_KEY]: { version: 1, state: checked },
    });
  } catch {
    throw new MatomoTaskConfigurationError("Matomo delivery metadata cannot be serialized.");
  }
  if (Buffer.byteLength(serialized, "utf8") > TRIGGER_METADATA_MAX_BYTES) {
    throw new MatomoTaskConfigurationError("Matomo delivery metadata limit exceeded.");
  }
  return checked;
}

const noCheckpoint: MatomoCheckpoint = {
  async load() {
    return null;
  },
  async assertCapacity(state) {
    validateCheckpointState(state);
  },
  async save() {},
};

const triggerMetadata: MatomoTriggerMetadata = {
  current: () => metadata.current(),
  set: (key, value) => metadata.set(key, value as never),
};

export function createTriggerMetadataCheckpoint(
  metadataApi: MatomoTriggerMetadata = triggerMetadata,
): MatomoCheckpoint {
  return {
    async load(input) {
      const current = metadataApi.current();
      const saved = checkpointRecord(current?.[MATOMO_DELIVERY_CHECKPOINT_KEY]);
      return saved === null ? null : validateCheckpointState(saved, input);
    },
    async assertCapacity(state) {
      projectedMetadata(state, metadataApi.current());
    },
    async save(state) {
      const saved = projectedMetadata(state, metadataApi.current());
      await metadataApi.set(MATOMO_DELIVERY_CHECKPOINT_KEY, {
        version: 1,
        state: saved,
      }).flush();
    },
  };
}

function failedEnvelope(input: MatomoInput, code: string, message: string) {
  const now = new Date().toISOString();
  return analysisEnvelopeSchema.parse({
    contractVersion: "1",
    runId: input.runId,
    clientId: input.clientId,
    brandId: input.brandId,
    siteId: input.siteId,
    siteMarketId: input.siteMarketId,
    source: "matomo",
    sourceVersion: "reporting-api-v5",
    adapterVersion: "1.0.0",
    status: "failed",
    startedAt: now,
    finishedAt: now,
    rawArtifact: null,
    observations: [],
    error: { code, message, retryable: false },
  });
}

async function defaultExecute(input: MatomoInput, token: string) {
  const provider = new MatomoClient({ endpoint: input.endpoint, token });
  return executeMatomo(input, {
    query: (request) => provider.query(request),
    maximumEnvelopeBytes: MATOMO_TRIGGER_ENVELOPE_BYTES,
  });
}

async function saveReadyEnvelope(
  checkpoint: MatomoCheckpoint,
  envelope: AnalysisEnvelope,
) {
  const state: MatomoDeliveryState = { stage: "ready", envelope };
  await checkpoint.assertCapacity(state);
  await checkpoint.save(state);
  return state;
}

function sameArtifact(
  left: NonNullable<AnalysisEnvelope["rawArtifact"]>,
  right: NonNullable<AnalysisEnvelope["rawArtifact"]>,
) {
  return left.uri === right.uri &&
    left.checksum === right.checksum &&
    left.mediaType === right.mediaType &&
    left.byteSize === right.byteSize;
}

function artifactPendingEnvelope(input: MatomoInput, execution: MatomoExecution) {
  return analysisEnvelopeSchema.parse({
    ...execution.envelope,
    rawArtifact: {
      uri: `artifact://${input.runId}/${MATOMO_ARTIFACT_NAME}`,
      checksum: `sha256:${createHash("sha256").update(execution.rawReport).digest("hex")}`,
      mediaType: MATOMO_ARTIFACT_MEDIA_TYPE,
      byteSize: execution.rawReport.byteLength,
    },
  });
}

async function finalizeArtifactPending(
  client: MatomoOpsClient,
  checkpoint: MatomoCheckpoint,
  envelope: AnalysisEnvelope,
) {
  await saveReadyEnvelope(checkpoint, envelope);
  await client.ingest(envelope);
  return envelope;
}

async function reconcileArtifactPending(
  input: MatomoInput,
  client: MatomoOpsClient,
  checkpoint: MatomoCheckpoint,
  envelope: AnalysisEnvelope,
) {
  const expected = envelope.rawArtifact;
  if (expected === null) {
    throw new MatomoTaskConfigurationError("Matomo artifact checkpoint is invalid.");
  }
  if (!await client.reconcileArtifact(
    input.runId,
    MATOMO_ARTIFACT_NAME,
    controlScope(input),
    expected,
  )) {
    return null;
  }
  return finalizeArtifactPending(client, checkpoint, envelope);
}

async function deliverProviderFailure(
  input: MatomoInput,
  client: MatomoOpsClient,
  checkpoint: MatomoCheckpoint,
  error: MatomoProviderError,
) {
  const envelope = failedEnvelope(
    input,
    "MATOMO_REQUEST_REJECTED",
    error.status === undefined
      ? "Matomo rejected the reporting request."
      : `Matomo rejected the reporting request with status ${error.status}.`,
  );
  await saveReadyEnvelope(checkpoint, envelope);
  await client.ingest(envelope);
  return envelope;
}

export async function runMatomoSync(
  value: MatomoInput,
  dependencies: MatomoSyncDependencies = {},
): Promise<AnalysisEnvelope> {
  const input = parseMatomoInput(value);
  const client = dependencies.client ?? await createDefaultMatomoOpsClient();
  const checkpoint = dependencies.checkpoint ?? noCheckpoint;
  const scope = controlScope(input);
  const saved = await checkpoint.load(input);
  if (saved !== null) {
    if (saved.stage === "auth-failure-pending") {
      await client.reportMatomoAuthenticationFailure(input.runId, scope);
      await checkpoint.save({ stage: "ready", envelope: saved.envelope });
    }
    if (saved.stage === "artifact-pending") {
      const finalized = await reconcileArtifactPending(
        input,
        client,
        checkpoint,
        saved.envelope,
      );
      if (finalized !== null) return finalized;
    } else {
      await client.ingest(saved.envelope);
      return saved.envelope;
    }
  }

  const { token } = await client.getMatomoCredential(input.runId, scope);
  let execution: MatomoExecution;
  try {
    execution = await (dependencies.execute ?? defaultExecute)(input, token);
  } catch (error) {
    if (error instanceof MatomoAuthenticationError) {
      const envelope = failedEnvelope(
        input,
        "MATOMO_AUTHENTICATION_FAILED",
        "Matomo credentials were rejected.",
      );
      const pending: MatomoDeliveryState = { stage: "auth-failure-pending", envelope };
      await checkpoint.assertCapacity(pending);
      await checkpoint.save(pending);
      await client.reportMatomoAuthenticationFailure(input.runId, scope);
      await checkpoint.save({ stage: "ready", envelope });
      await client.ingest(envelope);
      return envelope;
    }
    if (error instanceof MatomoProviderError) {
      if (error.retryable) {
        logger.warn("Matomo request will be retried.", {
          runId: input.runId,
          status: error.status,
          retryAfterSeconds: error.retryAfterSeconds,
        });
        throw error;
      }
      return deliverProviderFailure(input, client, checkpoint, error);
    }
    if (error instanceof MatomoExecutionError) {
      if (error.retryable) throw error;
      const envelope = failedEnvelope(
        input,
        "MATOMO_REPORT_REJECTED",
        "Matomo report evidence could not be retained safely.",
      );
      await saveReadyEnvelope(checkpoint, envelope);
      await client.ingest(envelope);
      return envelope;
    }
    throw error;
  }

  const envelope = artifactPendingEnvelope(input, execution);
  const pending: MatomoDeliveryState = { stage: "artifact-pending", envelope };
  await checkpoint.assertCapacity(pending);
  await checkpoint.save(pending);
  try {
    const uploaded = await client.uploadArtifact(
      input.runId,
      MATOMO_ARTIFACT_NAME,
      execution.rawReport,
      MATOMO_ARTIFACT_MEDIA_TYPE,
    );
    if (!sameArtifact(uploaded, envelope.rawArtifact!)) {
      throw new SgeoOpsClientError(
        "SGeoOps returned artifact metadata that does not match the durable checkpoint.",
        { retryable: false },
      );
    }
  } catch (error) {
    const finalized = await reconcileArtifactPending(input, client, checkpoint, envelope);
    if (finalized !== null) return finalized;
    throw error;
  }
  return finalizeArtifactPending(client, checkpoint, envelope);
}

export async function runMatomoSyncTask(
  value: unknown,
  dependencies: MatomoSyncDependencies = {},
) {
  let envelope: AnalysisEnvelope;
  try {
    envelope = await runMatomoSync(parseMatomoInput(value), {
      ...dependencies,
      checkpoint: dependencies.checkpoint ?? createTriggerMetadataCheckpoint(),
    });
  } catch (error) {
    if (
      error instanceof MatomoInputError ||
      error instanceof MatomoTaskConfigurationError ||
      (error instanceof MatomoExecutionError && !error.retryable) ||
      (error instanceof MatomoProviderError && !error.retryable) ||
      (error instanceof SgeoOpsClientError && !error.retryable)
    ) {
      throw new AbortTaskRunError(error.message);
    }
    throw error;
  }
  if (envelope.status === "failed" && envelope.error?.retryable === false) {
    throw new AbortTaskRunError(envelope.error.message);
  }
  return envelope;
}

export const matomoSyncTask = task({
  id: "matomo-sync",
  queue: { name: "matomo", concurrencyLimit: 2 },
  machine: "medium-1x",
  maxDuration: 900,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: (payload: unknown) => runMatomoSyncTask(payload),
});
