import { readFile } from "node:fs/promises";

import { analysisEnvelopeSchema, type AnalysisEnvelope } from "@sgeo/analysis-contract";
import { AbortTaskRunError, logger, metadata, task } from "@trigger.dev/sdk";

import {
  executeSearchConsole,
  parseSearchConsoleInput,
  SEARCH_CONSOLE_ARTIFACT_MEDIA_TYPE,
  SEARCH_CONSOLE_ARTIFACT_NAME,
  SearchConsoleExecutionError,
  SearchConsoleInputError,
  type SearchConsoleExecution,
  type SearchConsoleInput,
} from "../adapters/search-console";
import {
  SearchConsoleAuthenticationError,
  SearchConsoleClient,
  SearchConsoleProviderError,
} from "../clients/search-console";
import {
  SgeoOpsClient,
  SgeoOpsClientError,
  type SearchConsoleControlScope,
} from "../clients/sgeo-ops";

export const SEARCH_CONSOLE_DAILY_DISPATCH_CRON = "0 4 * * *";
export const SEARCH_CONSOLE_TRIGGER_ENVELOPE_BYTES = 192 * 1024;
const SEARCH_CONSOLE_DELIVERY_CHECKPOINT_KEY = "searchConsoleDeliveryCheckpoint";
const TRIGGER_METADATA_MAX_BYTES = 256 * 1024;

type SearchConsoleOpsClient = Pick<
  SgeoOpsClient,
  | "getSearchConsoleCredential"
  | "reportSearchConsoleAuthenticationFailure"
  | "uploadArtifact"
  | "ingest"
>;

export type SearchConsoleDeliveryState = {
  stage: "auth-failure-pending" | "ready";
  envelope: AnalysisEnvelope;
};

export interface SearchConsoleDeliveryCheckpoint {
  load(input: SearchConsoleInput): Promise<SearchConsoleDeliveryState | null>;
  assertCapacity(state: SearchConsoleDeliveryState): Promise<void>;
  save(state: SearchConsoleDeliveryState): Promise<void>;
}

export type SearchConsoleSyncDependencies = {
  execute?: (
    input: SearchConsoleInput,
    token: string,
  ) => Promise<SearchConsoleExecution>;
  client?: SearchConsoleOpsClient;
  checkpoint?: SearchConsoleDeliveryCheckpoint;
};

export type SearchConsoleTriggerMetadata = {
  current(): Record<string, unknown> | undefined;
  set(key: string, value: unknown): { flush(): Promise<void> };
};

export class SearchConsoleTaskConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchConsoleTaskConfigurationError";
  }
}

function internalOriginBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SearchConsoleTaskConfigurationError("SGEO_INTERNAL_URL must be an HTTP(S) origin.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new SearchConsoleTaskConfigurationError(
      "SGEO_INTERNAL_URL must be an HTTP(S) origin without credentials, path, query, or fragment.",
    );
  }
  return parsed.origin;
}

async function defaultClient(): Promise<SearchConsoleOpsClient> {
  const configuredBaseUrl = process.env.SGEO_INTERNAL_URL;
  const secretFile = process.env.SGEO_INTERNAL_SECRET_FILE;
  if (!configuredBaseUrl) {
    throw new SearchConsoleTaskConfigurationError("SGEO_INTERNAL_URL is required.");
  }
  if (!secretFile) {
    throw new SearchConsoleTaskConfigurationError("SGEO_INTERNAL_SECRET_FILE is required.");
  }
  const baseUrl = internalOriginBaseUrl(configuredBaseUrl);
  let secret: string;
  try {
    secret = (await readFile(secretFile, "utf8")).trim();
  } catch {
    throw new SearchConsoleTaskConfigurationError("SGEO_INTERNAL_SECRET_FILE could not be read.");
  }
  if (secret.length === 0) {
    throw new SearchConsoleTaskConfigurationError("SGEO_INTERNAL_SECRET_FILE must contain a secret.");
  }
  return new SgeoOpsClient({ baseUrl, secret });
}

function controlScope(input: SearchConsoleInput): SearchConsoleControlScope {
  return {
    clientId: input.clientId,
    brandId: input.brandId,
    siteId: input.siteId,
    siteMarketId: input.siteMarketId,
    integrationId: input.integrationId,
    property: input.property,
  };
}

function validateCheckpointState(value: unknown, input?: SearchConsoleInput): SearchConsoleDeliveryState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SearchConsoleTaskConfigurationError("Search Console delivery checkpoint is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (record.stage !== "auth-failure-pending" && record.stage !== "ready") {
    throw new SearchConsoleTaskConfigurationError("Search Console delivery checkpoint is invalid.");
  }
  const envelope = analysisEnvelopeSchema.safeParse(record.envelope);
  if (!envelope.success || envelope.data.source !== "search-console") {
    throw new SearchConsoleTaskConfigurationError("Search Console delivery checkpoint is invalid.");
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
    throw new SearchConsoleTaskConfigurationError(
      "Search Console delivery checkpoint does not match the task payload.",
    );
  }
  if (record.stage === "auth-failure-pending" && envelope.data.error?.code !== "SEARCH_CONSOLE_AUTHENTICATION_FAILED") {
    throw new SearchConsoleTaskConfigurationError(
      "Search Console authentication checkpoint is invalid.",
    );
  }
  return { stage: record.stage, envelope: envelope.data };
}

function checkpointRecord(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SearchConsoleTaskConfigurationError("Search Console delivery checkpoint is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new SearchConsoleTaskConfigurationError("Search Console delivery checkpoint is invalid.");
  }
  return record.state;
}

function projectedMetadata(
  state: SearchConsoleDeliveryState,
  currentMetadata: Record<string, unknown> | undefined,
) {
  const checked = validateCheckpointState(state);
  let serialized: string;
  try {
    serialized = JSON.stringify({
      ...(currentMetadata ?? {}),
      [SEARCH_CONSOLE_DELIVERY_CHECKPOINT_KEY]: { version: 1, state: checked },
    });
  } catch {
    throw new SearchConsoleTaskConfigurationError(
      "Search Console delivery metadata cannot be serialized.",
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > TRIGGER_METADATA_MAX_BYTES) {
    throw new SearchConsoleTaskConfigurationError(
      "Search Console delivery metadata limit exceeded.",
    );
  }
  return checked;
}

const noOpCheckpoint: SearchConsoleDeliveryCheckpoint = {
  async load() {
    return null;
  },
  async assertCapacity(state) {
    validateCheckpointState(state);
  },
  async save() {},
};

const triggerMetadata: SearchConsoleTriggerMetadata = {
  current: () => metadata.current(),
  set: (key, value) => metadata.set(key, value as never),
};

export function createTriggerMetadataCheckpoint(
  metadataApi: SearchConsoleTriggerMetadata = triggerMetadata,
): SearchConsoleDeliveryCheckpoint {
  return {
    async load(input) {
      const current = metadataApi.current();
      const saved = checkpointRecord(current?.[SEARCH_CONSOLE_DELIVERY_CHECKPOINT_KEY]);
      return saved === null ? null : validateCheckpointState(saved, input);
    },
    async assertCapacity(state) {
      projectedMetadata(state, metadataApi.current());
    },
    async save(state) {
      const saved = projectedMetadata(state, metadataApi.current());
      await metadataApi.set(SEARCH_CONSOLE_DELIVERY_CHECKPOINT_KEY, {
        version: 1,
        state: saved,
      }).flush();
    },
  };
}

function failedEnvelope(
  input: SearchConsoleInput,
  code: string,
  message: string,
): AnalysisEnvelope {
  const now = new Date().toISOString();
  return analysisEnvelopeSchema.parse({
    contractVersion: "1",
    runId: input.runId,
    clientId: input.clientId,
    brandId: input.brandId,
    siteId: input.siteId,
    siteMarketId: input.siteMarketId,
    source: "search-console",
    sourceVersion: "webmasters-v3",
    adapterVersion: "1.0.0",
    status: "failed",
    startedAt: now,
    finishedAt: now,
    rawArtifact: null,
    observations: [],
    error: { code, message, retryable: false },
  });
}

async function defaultExecute(input: SearchConsoleInput, token: string) {
  return executeSearchConsole(input, {
    client: new SearchConsoleClient({ token }),
    maximumEnvelopeBytes: SEARCH_CONSOLE_TRIGGER_ENVELOPE_BYTES,
  });
}

async function saveReadyEnvelope(
  checkpoint: SearchConsoleDeliveryCheckpoint,
  envelope: AnalysisEnvelope,
) {
  const state: SearchConsoleDeliveryState = { stage: "ready", envelope };
  await checkpoint.assertCapacity(state);
  await checkpoint.save(state);
  return state;
}

async function deliverProviderFailure(
  input: SearchConsoleInput,
  client: SearchConsoleOpsClient,
  checkpoint: SearchConsoleDeliveryCheckpoint,
  error: SearchConsoleProviderError,
) {
  const envelope = failedEnvelope(
    input,
    "SEARCH_CONSOLE_REQUEST_REJECTED",
    error.status === undefined
      ? "Search Console rejected the request."
      : `Search Console rejected the request with status ${error.status}.`,
  );
  await saveReadyEnvelope(checkpoint, envelope);
  await client.ingest(envelope);
  return envelope;
}

export async function runSearchConsoleSync(
  value: SearchConsoleInput,
  dependencies: SearchConsoleSyncDependencies = {},
): Promise<AnalysisEnvelope> {
  const input = parseSearchConsoleInput(value);
  const client = dependencies.client ?? await defaultClient();
  const checkpoint = dependencies.checkpoint ?? noOpCheckpoint;
  const scope = controlScope(input);
  const saved = await checkpoint.load(input);
  if (saved !== null) {
    if (saved.stage === "auth-failure-pending") {
      await client.reportSearchConsoleAuthenticationFailure(input.runId, scope);
      await checkpoint.save({ stage: "ready", envelope: saved.envelope });
    }
    await client.ingest(saved.envelope);
    return saved.envelope;
  }

  const { token } = await client.getSearchConsoleCredential(input.runId, scope);
  let execution: SearchConsoleExecution;
  try {
    execution = await (dependencies.execute ?? defaultExecute)(input, token);
  } catch (error) {
    if (error instanceof SearchConsoleAuthenticationError) {
      const envelope = failedEnvelope(
        input,
        "SEARCH_CONSOLE_AUTHENTICATION_FAILED",
        "Search Console credentials were rejected.",
      );
      const pending: SearchConsoleDeliveryState = { stage: "auth-failure-pending", envelope };
      await checkpoint.assertCapacity(pending);
      await checkpoint.save(pending);
      await client.reportSearchConsoleAuthenticationFailure(input.runId, scope);
      await checkpoint.save({ stage: "ready", envelope });
      await client.ingest(envelope);
      return envelope;
    }
    if (error instanceof SearchConsoleProviderError) {
      if (error.retryable) {
        logger.warn("Search Console request will be retried.", {
          runId: input.runId,
          status: error.status,
          retryAfterSeconds: error.retryAfterSeconds,
        });
        throw error;
      }
      return deliverProviderFailure(input, client, checkpoint, error);
    }
    throw error;
  }

  let envelope = execution.envelope;
  if (execution.rawReport !== null) {
    const capacityCandidate = analysisEnvelopeSchema.parse({
      ...envelope,
      rawArtifact: {
        uri: `artifact://${input.runId}/${SEARCH_CONSOLE_ARTIFACT_NAME}`,
        checksum: `sha256:${"0".repeat(64)}`,
        mediaType: SEARCH_CONSOLE_ARTIFACT_MEDIA_TYPE,
        byteSize: execution.rawReport.byteLength,
      },
    });
    await checkpoint.assertCapacity({ stage: "ready", envelope: capacityCandidate });
    const rawArtifact = await client.uploadArtifact(
      input.runId,
      SEARCH_CONSOLE_ARTIFACT_NAME,
      execution.rawReport,
      SEARCH_CONSOLE_ARTIFACT_MEDIA_TYPE,
    );
    envelope = analysisEnvelopeSchema.parse({ ...envelope, rawArtifact });
  } else {
    await checkpoint.assertCapacity({ stage: "ready", envelope });
  }
  await checkpoint.save({ stage: "ready", envelope });
  await client.ingest(envelope);
  return envelope;
}

export async function runSearchConsoleSyncTask(
  input: unknown,
  dependencies: SearchConsoleSyncDependencies = {},
) {
  let envelope: AnalysisEnvelope;
  try {
    envelope = await runSearchConsoleSync(parseSearchConsoleInput(input), {
      ...dependencies,
      checkpoint: dependencies.checkpoint ?? createTriggerMetadataCheckpoint(),
    });
  } catch (error) {
    if (
      error instanceof SearchConsoleInputError ||
      error instanceof SearchConsoleTaskConfigurationError ||
      (error instanceof SearchConsoleExecutionError && !error.retryable) ||
      (error instanceof SearchConsoleProviderError && !error.retryable) ||
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

export const searchConsoleSyncTask = task({
  id: "search-console-sync",
  queue: { name: "search-console", concurrencyLimit: 2 },
  machine: "medium-1x",
  maxDuration: 900,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  // External dispatch creates one typed run per integration at 04:00 daily.
  run: (payload: unknown) => runSearchConsoleSyncTask(payload),
});
