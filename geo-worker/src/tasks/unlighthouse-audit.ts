import { analysisEnvelopeSchema, type AnalysisEnvelope } from "@sgeo/analysis-contract";
import { AbortTaskRunError, logger, metadata, task } from "@trigger.dev/sdk";

import {
  executeUnlighthouse,
  UNLIGHTHOUSE_ARTIFACT_MEDIA_TYPE,
  UNLIGHTHOUSE_ARTIFACT_NAME,
  UnlighthouseInputError,
  parseUnlighthouseInput,
  type UnlighthouseExecution,
  type UnlighthouseInput,
} from "../adapters/unlighthouse";
import { SgeoOpsClient, SgeoOpsClientError } from "../clients/sgeo-ops";
import { InternalSgeoAuthError, readInternalSgeoSecret } from "./internal-sgeo-auth";

type UnlighthouseOpsClient = Pick<SgeoOpsClient, "ingest" | "uploadArtifact">;

const UNLIGHTHOUSE_DELIVERY_CHECKPOINT_KEY = "unlighthouseDeliveryCheckpoint";
const TRIGGER_METADATA_MAX_BYTES = 256 * 1024;

export interface UnlighthouseDeliveryCheckpoint {
  load(input: UnlighthouseInput): Promise<AnalysisEnvelope | null>;
  assertCapacity(envelope: AnalysisEnvelope): Promise<void>;
  save(envelope: AnalysisEnvelope): Promise<void>;
}

export type UnlighthouseTriggerMetadata = {
  current(): Record<string, unknown> | undefined;
  set(key: string, value: unknown): { flush(): Promise<void> };
};

export type UnlighthouseAuditDependencies = {
  execute?: (input: UnlighthouseInput) => Promise<UnlighthouseExecution>;
  client?: UnlighthouseOpsClient;
  checkpoint?: UnlighthouseDeliveryCheckpoint;
};

export class UnlighthouseTaskConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnlighthouseTaskConfigurationError";
  }
}

function internalOriginBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UnlighthouseTaskConfigurationError("SGEO_INTERNAL_URL must be an HTTP(S) origin.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new UnlighthouseTaskConfigurationError(
      "SGEO_INTERNAL_URL must be an HTTP(S) origin without credentials, path, query, or fragment.",
    );
  }
  return parsed.origin;
}

async function defaultClient(): Promise<UnlighthouseOpsClient> {
  const configuredBaseUrl = process.env.SGEO_INTERNAL_URL;
  if (!configuredBaseUrl) {
    throw new UnlighthouseTaskConfigurationError("SGEO_INTERNAL_URL is required.");
  }

  const baseUrl = internalOriginBaseUrl(configuredBaseUrl);

  let secret: string;
  try {
    secret = await readInternalSgeoSecret();
  } catch (error) {
    throw new UnlighthouseTaskConfigurationError(
      error instanceof InternalSgeoAuthError ? error.message : "SGeoOps internal secret is invalid.",
    );
  }
  return new SgeoOpsClient({ baseUrl, secret });
}

function checkpointEnvelope(value: unknown, input?: UnlighthouseInput): AnalysisEnvelope {
  const parsed = analysisEnvelopeSchema.safeParse(value);
  if (!parsed.success || parsed.data.rawArtifact === null) {
    throw new Error("Unlighthouse delivery checkpoint is invalid.");
  }
  if (
    input !== undefined &&
    (
      parsed.data.runId !== input.runId ||
      parsed.data.clientId !== input.clientId ||
      parsed.data.brandId !== input.brandId ||
      parsed.data.siteId !== input.siteId ||
      parsed.data.siteMarketId !== input.siteMarketId ||
      parsed.data.source !== "unlighthouse"
    )
  ) {
    throw new Error("Unlighthouse delivery checkpoint does not match the task payload.");
  }
  return parsed.data;
}

function checkpointRecord(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.version === 1 ? record.envelope : null;
}

function projectedMetadata(
  envelope: AnalysisEnvelope,
  currentMetadata: Record<string, unknown> | undefined,
) {
  const current = currentMetadata ?? {};
  const checkpoint = checkpointEnvelope(envelope);
  let serialized: string;
  try {
    serialized = JSON.stringify({
      ...current,
      [UNLIGHTHOUSE_DELIVERY_CHECKPOINT_KEY]: { version: 1, envelope: checkpoint },
    });
  } catch {
    throw new Error("Unlighthouse delivery metadata cannot be serialized.");
  }
  if (Buffer.byteLength(serialized, "utf8") > TRIGGER_METADATA_MAX_BYTES) {
    throw new Error("Unlighthouse delivery metadata limit exceeded.");
  }
  return checkpoint;
}

async function checkCheckpointCapacity(
  checkpoint: UnlighthouseDeliveryCheckpoint,
  envelope: AnalysisEnvelope,
  input: UnlighthouseInput,
  rawReport: Uint8Array,
) {
  const candidate = checkpointEnvelope({
    ...envelope,
    rawArtifact: {
      uri: `artifact://${input.runId}/${UNLIGHTHOUSE_ARTIFACT_NAME}`,
      checksum: `sha256:${"0".repeat(64)}`,
      mediaType: UNLIGHTHOUSE_ARTIFACT_MEDIA_TYPE,
      byteSize: rawReport.byteLength,
    },
  });
  await checkpoint.assertCapacity(candidate);
}

const noOpCheckpoint: UnlighthouseDeliveryCheckpoint = {
  async load() {
    return null;
  },
  async assertCapacity(envelope) {
    checkpointEnvelope(envelope);
  },
  async save() {},
};

const triggerMetadata: UnlighthouseTriggerMetadata = {
  current: () => metadata.current(),
  set: (key, value) => metadata.set(key, value as never),
};

export function createTriggerMetadataCheckpoint(
  metadataApi: UnlighthouseTriggerMetadata = triggerMetadata,
): UnlighthouseDeliveryCheckpoint {
  return {
    async load(input) {
      const current = metadataApi.current();
      const saved = checkpointRecord(current?.[UNLIGHTHOUSE_DELIVERY_CHECKPOINT_KEY]);
      return saved === null ? null : checkpointEnvelope(saved, input);
    },
    async assertCapacity(envelope) {
      projectedMetadata(envelope, metadataApi.current());
    },
    async save(envelope) {
      const saved = projectedMetadata(envelope, metadataApi.current());
      await metadataApi.set(UNLIGHTHOUSE_DELIVERY_CHECKPOINT_KEY, {
        version: 1,
        envelope: saved,
      }).flush();
    },
  };
}

export async function runUnlighthouseAudit(
  input: UnlighthouseInput,
  dependencies: UnlighthouseAuditDependencies = {},
): Promise<AnalysisEnvelope> {
  const parsedInput = parseUnlighthouseInput(input);
  const client = dependencies.client ?? await defaultClient();
  const checkpoint = dependencies.checkpoint ?? noOpCheckpoint;
  const saved = await checkpoint.load(parsedInput);
  if (saved !== null) {
    await client.ingest(saved);
    return saved;
  }

  const execution = await (dependencies.execute ?? executeUnlighthouse)(parsedInput);
  let envelope = execution.envelope;

  if (execution.rawReport === null) {
    logger.warn("Unlighthouse did not produce a JSON artifact.", {
      runId: parsedInput.runId,
      status: envelope.status,
    });
  } else {
    // Reject a full Trigger metadata object before publishing the fixed-name artifact.
    await checkCheckpointCapacity(checkpoint, envelope, parsedInput, execution.rawReport);
    const rawArtifact = await client.uploadArtifact(
      parsedInput.runId,
      UNLIGHTHOUSE_ARTIFACT_NAME,
      execution.rawReport,
      UNLIGHTHOUSE_ARTIFACT_MEDIA_TYPE,
    );
    envelope = analysisEnvelopeSchema.parse({ ...envelope, rawArtifact });
    // Persist the small, validated delivery marker before ingest to make retries replay-safe.
    await checkpoint.save(envelope);
  }

  await client.ingest(envelope);
  return envelope;
}

async function runUnlighthouseAuditTask(input: unknown) {
  try {
    return await runUnlighthouseAudit(parseUnlighthouseInput(input), {
      checkpoint: createTriggerMetadataCheckpoint(),
    });
  } catch (error) {
    if (
      error instanceof UnlighthouseInputError ||
      error instanceof UnlighthouseTaskConfigurationError ||
      (error instanceof SgeoOpsClientError && !error.retryable)
    ) {
      throw new AbortTaskRunError(error.message);
    }
    throw error;
  }
}

export const unlighthouseAuditTask = task({
  id: "unlighthouse-audit",
  queue: { name: "unlighthouse", concurrencyLimit: 1 },
  machine: "medium-1x",
  maxDuration: 900,
  // SGeoOps has no signed run-intent read API; external scheduling supplies this strict payload.
  run: runUnlighthouseAuditTask,
});
