import { eventTrigger, type JobIO } from "@trigger.dev/sdk";
import { z } from "zod";

import { client } from "../trigger";

const GENERATE_URL = process.env.GEO_OPS_INTERNAL_URL ?? "http://localhost:3000";

client.defineJob({
  id: "content-generate",
  name: "内容生成（话题审批后）",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "trend.approved",
    schema: z.object({ topicId: z.string(), keyword: z.string(), platform: z.string() }),
  }),
  run: async (payload: unknown, io: JobIO) => {
    const event = payload as { topicId: string; keyword: string; platform: string };
    await io.logger.info("Calling content-generate API", { topicId: event.topicId });

    const response = await fetch(`${GENERATE_URL}/api/internal/content-generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
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
