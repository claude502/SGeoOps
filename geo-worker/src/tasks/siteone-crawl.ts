import { readFile } from "node:fs/promises";

import { analysisEnvelopeSchema, type AnalysisEnvelope } from "@sgeo/analysis-contract";
import { logger, metadata, task } from "@trigger.dev/sdk";

import {
  executeSiteOne,
  SITEONE_ARTIFACT_MEDIA_TYPE,
  SITEONE_ARTIFACT_NAME,
  type SiteOneExecution,
  type SiteOneInput,
} from "../adapters/siteone";
import { SgeoOpsClient } from "../clients/sgeo-ops";

type SiteOneOpsClient = Pick<SgeoOpsClient, "ingest" | "uploadArtifact">;

const SITEONE_DELIVERY_CHECKPOINT_KEY = "siteoneDeliveryCheckpoint";
const SITEONE_MAX_CHECKPOINT_BYTES = 200 * 1024;

export interface SiteOneDeliveryCheckpoint {
  load(input: SiteOneInput): Promise<AnalysisEnvelope | null>;
  save(envelope: AnalysisEnvelope): Promise<void>;
}

export type SiteOneCrawlDependencies = {
  execute?: (input: SiteOneInput) => Promise<SiteOneExecution>;
  client?: SiteOneOpsClient;
  checkpoint?: SiteOneDeliveryCheckpoint;
};

async function defaultClient(): Promise<SiteOneOpsClient> {
  const baseUrl = process.env.SGEO_INTERNAL_URL;
  const secretFile = process.env.SGEO_INTERNAL_SECRET_FILE;
  if (!baseUrl || !secretFile) {
    throw new Error("SGEO_INTERNAL_URL and SGEO_INTERNAL_SECRET_FILE are required.");
  }
  const secret = (await readFile(secretFile, "utf8")).trim();
  if (secret.length === 0) {
    throw new Error("SGEO_INTERNAL_SECRET_FILE must contain a secret.");
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
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > SITEONE_MAX_CHECKPOINT_BYTES) {
    throw new Error("SiteOne delivery checkpoint exceeds the Trigger metadata limit.");
  }
  return parsed.data;
}

function checkpointRecord(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.version === 1 ? record.envelope : null;
}

function checkCheckpointCapacity(
  envelope: AnalysisEnvelope,
  input: SiteOneInput,
  rawReport: Uint8Array,
) {
  checkpointEnvelope({
    ...envelope,
    rawArtifact: {
      uri: `artifact://${input.runId}/${SITEONE_ARTIFACT_NAME}`,
      checksum: `sha256:${"0".repeat(64)}`,
      mediaType: SITEONE_ARTIFACT_MEDIA_TYPE,
      byteSize: rawReport.byteLength,
    },
  });
}

const noOpCheckpoint: SiteOneDeliveryCheckpoint = {
  async load() {
    return null;
  },
  async save() {},
};

export function createTriggerMetadataCheckpoint(): SiteOneDeliveryCheckpoint {
  return {
    async load(input) {
      const current = metadata.current();
      const saved = checkpointRecord(current?.[SITEONE_DELIVERY_CHECKPOINT_KEY]);
      return saved === null ? null : checkpointEnvelope(saved, input);
    },
    async save(envelope) {
      const saved = checkpointEnvelope(envelope);
      await metadata.set(SITEONE_DELIVERY_CHECKPOINT_KEY, {
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
    checkCheckpointCapacity(envelope, input, execution.rawReport);
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

export const siteOneCrawlTask = task({
  id: "siteone-crawl",
  queue: { name: "siteone", concurrencyLimit: 2 },
  machine: "medium-1x",
  maxDuration: 900,
  // SGeoOps has no signed run-intent read API yet; scheduling and dispatch supply this payload externally.
  run: async (input: SiteOneInput) => runSiteOneCrawl(input, {
    checkpoint: createTriggerMetadataCheckpoint(),
  }),
});
