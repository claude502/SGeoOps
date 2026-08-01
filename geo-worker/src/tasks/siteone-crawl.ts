import { readFile } from "node:fs/promises";

import type { AnalysisEnvelope } from "@sgeo/analysis-contract";
import { logger, task } from "@trigger.dev/sdk";

import {
  executeSiteOne,
  SITEONE_ARTIFACT_MEDIA_TYPE,
  SITEONE_ARTIFACT_NAME,
  type SiteOneExecution,
  type SiteOneInput,
} from "../adapters/siteone";
import { SgeoOpsClient } from "../clients/sgeo-ops";

type SiteOneOpsClient = Pick<SgeoOpsClient, "ingest" | "uploadArtifact">;

export type SiteOneCrawlDependencies = {
  execute?: (input: SiteOneInput) => Promise<SiteOneExecution>;
  client?: SiteOneOpsClient;
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

export async function runSiteOneCrawl(
  input: SiteOneInput,
  dependencies: SiteOneCrawlDependencies = {},
): Promise<AnalysisEnvelope> {
  const client = dependencies.client ?? await defaultClient();
  const execution = await (dependencies.execute ?? executeSiteOne)(input);
  let envelope = execution.envelope;

  if (execution.rawReport === null) {
    logger.warn("SiteOne did not produce a JSON artifact.", {
      runId: input.runId,
      status: envelope.status,
    });
  } else {
    const rawArtifact = await client.uploadArtifact(
      input.runId,
      SITEONE_ARTIFACT_NAME,
      execution.rawReport,
      SITEONE_ARTIFACT_MEDIA_TYPE,
    );
    envelope = { ...envelope, rawArtifact };
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
  run: async (input: SiteOneInput) => runSiteOneCrawl(input),
});
