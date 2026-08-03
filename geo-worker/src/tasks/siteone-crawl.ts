import { analysisEnvelopeSchema, type AnalysisEnvelope } from "@sgeo/analysis-contract";
import { AbortTaskRunError, logger, metadata, task } from "@trigger.dev/sdk";

import {
  executeSiteOne,
  SITEONE_ARTIFACT_MEDIA_TYPE,
  SITEONE_ARTIFACT_NAME,
  SiteOneInputError,
  type SiteOneExecution,
  type SiteOneInput,
} from "../adapters/siteone";
import { SgeoOpsClient, SgeoOpsClientError } from "../clients/sgeo-ops";
import { InternalSgeoAuthError, readInternalSgeoSecret } from "./internal-sgeo-auth";

type SiteOneOpsClient = Pick<SgeoOpsClient, "ingest" | "uploadArtifact">;

const SITEONE_DELIVERY_CHECKPOINT_KEY = "siteoneDeliveryCheckpoint";
const TRIGGER_METADATA_MAX_BYTES = 256 * 1024;

export interface SiteOneDeliveryCheckpoint {
  load(input: SiteOneInput): Promise<AnalysisEnvelope | null>;
  assertCapacity(envelope: AnalysisEnvelope): Promise<void>;
  save(envelope: AnalysisEnvelope): Promise<void>;
}

export type SiteOneTriggerMetadata = {
  current(): Record<string, unknown> | undefined;
  set(key: string, value: unknown): { flush(): Promise<void> };
};

export type SiteOneCrawlDependencies = {
  execute?: (input: SiteOneInput) => Promise<SiteOneExecution>;
  client?: SiteOneOpsClient;
  checkpoint?: SiteOneDeliveryCheckpoint;
};

export class SiteOneTaskConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteOneTaskConfigurationError";
  }
}

async function defaultClient(): Promise<SiteOneOpsClient> {
  const baseUrl = process.env.SGEO_INTERNAL_URL;
  if (!baseUrl) {
    throw new SiteOneTaskConfigurationError("SGEO_INTERNAL_URL is required.");
  }

  let secret: string;
  try {
    secret = await readInternalSgeoSecret();
  } catch (error) {
    throw new SiteOneTaskConfigurationError(
      error instanceof InternalSgeoAuthError ? error.message : "SGeoOps internal secret is invalid.",
    );
  }
  return new SgeoOpsClient({ baseUrl, secret });
}

function checkpointEnvelope(value: unknown, input?: SiteOneInput): AnalysisEnvelope {
  const parsed = analysisEnvelopeSchema.safeParse(value);
  if (!parsed.success || parsed.data.rawArtifact === null) {
    throw new Error("SiteOne delivery checkpoint is invalid.");
  }
  if (
    input !== undefined &&
    (
      parsed.data.runId !== input.runId ||
      parsed.data.clientId !== input.clientId ||
      parsed.data.brandId !== input.brandId ||
      parsed.data.siteId !== input.siteId ||
      parsed.data.siteMarketId !== input.siteMarketId ||
      parsed.data.source !== "siteone"
    )
  ) {
    throw new Error("SiteOne delivery checkpoint does not match the task payload.");
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
      [SITEONE_DELIVERY_CHECKPOINT_KEY]: { version: 1, envelope: checkpoint },
    });
  } catch {
    throw new Error("SiteOne delivery metadata cannot be serialized.");
  }
  if (Buffer.byteLength(serialized, "utf8") > TRIGGER_METADATA_MAX_BYTES) {
    throw new Error("SiteOne delivery metadata limit exceeded.");
  }
  return checkpoint;
}

async function checkCheckpointCapacity(
  checkpoint: SiteOneDeliveryCheckpoint,
  envelope: AnalysisEnvelope,
  input: SiteOneInput,
  rawReport: Uint8Array,
) {
  const candidate = checkpointEnvelope({
    ...envelope,
    rawArtifact: {
      uri: `artifact://${input.runId}/${SITEONE_ARTIFACT_NAME}`,
      checksum: `sha256:${"0".repeat(64)}`,
      mediaType: SITEONE_ARTIFACT_MEDIA_TYPE,
      byteSize: rawReport.byteLength,
    },
  });
  await checkpoint.assertCapacity(candidate);
}

const noOpCheckpoint: SiteOneDeliveryCheckpoint = {
  async load() {
    return null;
  },
  async assertCapacity(envelope) {
    checkpointEnvelope(envelope);
  },
  async save() {},
};

const triggerMetadata: SiteOneTriggerMetadata = {
  current: () => metadata.current(),
  set: (key, value) => metadata.set(key, value as never),
};

export function createTriggerMetadataCheckpoint(
  metadataApi: SiteOneTriggerMetadata = triggerMetadata,
): SiteOneDeliveryCheckpoint {
  return {
    async load(input) {
      const current = metadataApi.current();
      const saved = checkpointRecord(current?.[SITEONE_DELIVERY_CHECKPOINT_KEY]);
      return saved === null ? null : checkpointEnvelope(saved, input);
    },
    async assertCapacity(envelope) {
      projectedMetadata(envelope, metadataApi.current());
    },
    async save(envelope) {
      const saved = projectedMetadata(envelope, metadataApi.current());
      await metadataApi.set(SITEONE_DELIVERY_CHECKPOINT_KEY, {
        version: 1,
        envelope: saved,
      }).flush();
    },
  };
}

export async function runSiteOneCrawl(
  input: SiteOneInput,
  dependencies: SiteOneCrawlDependencies = {},
): Promise<AnalysisEnvelope> {
  const client = dependencies.client ?? await defaultClient();
  const checkpoint = dependencies.checkpoint ?? noOpCheckpoint;
  const saved = await checkpoint.load(input);
  if (saved !== null) {
    await client.ingest(saved);
    return saved;
  }

  const execution = await (dependencies.execute ?? executeSiteOne)(input);
  let envelope = execution.envelope;

  if (execution.rawReport === null) {
    logger.warn("SiteOne did not produce a JSON artifact.", {
      runId: input.runId,
      status: envelope.status,
    });
  } else {
    // Validate capacity before publishing the fixed-name artifact. Otherwise a
    // metadata-size failure could leave an upload that a changed recrawl cannot replay.
    await checkCheckpointCapacity(checkpoint, envelope, input, execution.rawReport);
    const rawArtifact = await client.uploadArtifact(
      input.runId,
      SITEONE_ARTIFACT_NAME,
      execution.rawReport,
      SITEONE_ARTIFACT_MEDIA_TYPE,
    );
    envelope = analysisEnvelopeSchema.parse({ ...envelope, rawArtifact });
    // A durable metadata flush closes the ordinary upload-success/ingest-retry gap.
    // The saved value is validated, compact, and contains no report bytes.
    await checkpoint.save(envelope);
  }

  await client.ingest(envelope);
  return envelope;
}

async function runSiteOneCrawlTask(input: SiteOneInput) {
  try {
    return await runSiteOneCrawl(input, {
      checkpoint: createTriggerMetadataCheckpoint(),
    });
  } catch (error) {
    if (
      error instanceof SiteOneInputError ||
      error instanceof SiteOneTaskConfigurationError ||
      (error instanceof SgeoOpsClientError && !error.retryable)
    ) {
      throw new AbortTaskRunError(error.message);
    }
    throw error;
  }
}

export const siteOneCrawlTask = task({
  id: "siteone-crawl",
  queue: { name: "siteone", concurrencyLimit: 2 },
  machine: "medium-1x",
  maxDuration: 900,
  // SGeoOps has no signed run-intent read API yet; scheduling and dispatch supply this payload externally.
  run: runSiteOneCrawlTask,
});
