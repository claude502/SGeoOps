import { readFile } from "node:fs/promises";
import { signInternalRequest } from "@sgeo/internal-protocol";
import { eventTrigger, type JobIO } from "@trigger.dev/sdk";
import { z } from "zod";

import { client } from "../trigger";

const GENERATE_URL = process.env.GEO_OPS_INTERNAL_URL ?? "http://localhost:3000";
const GENERATE_PATH = "/api/internal/content-generate";

async function internalSecret() {
  const inline = process.env.SGEO_INTERNAL_SECRET?.trim();
  if (inline) {
    return inline;
  }
  const path = process.env.SGEO_INTERNAL_SECRET_FILE?.trim();
  if (!path) {
    throw new Error("SGEO internal request secret is not configured");
  }
  const secret = (await readFile(path, "utf8")).trim();
  if (!secret) {
    throw new Error("SGEO internal request secret is empty");
  }
  return secret;
}

client.defineJob({
  id: "content-generate",
  name: "内容生成（话题审批后）",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "trend.approved",
    schema: z.object({
      topicId: z.string(),
      keyword: z.string().optional(),
      platform: z.string().optional(),
    }),
  }),
  run: async (payload: unknown, io: JobIO) => {
    const event = payload as {
      topicId: string;
      keyword?: string;
      platform?: string;
    };
    await io.logger.info("Calling content-generate API", { topicId: event.topicId });

    const body = JSON.stringify(event);
    const signed = await signInternalRequest(
      await internalSecret(),
      "POST",
      GENERATE_PATH,
      body,
    );
    const response = await fetch(`${GENERATE_URL}${GENERATE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sgeo-timestamp": signed.timestamp,
        "x-sgeo-signature": signed.signature,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      throw new Error(`content-generate API returned ${response.status}: ${text}`);
    }

    const result = await response.json();
    await io.logger.info("Content generated", result);
    return result;
  },
});
