import { eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

import { client } from "../trigger";

client.defineJob({
  id: "content-generate",
  name: "内容生成（话题审批后）",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "trend.approved",
    schema: z.object({ topicId: z.string(), keyword: z.string(), platform: z.string() }),
  }),
  run: async (payload: unknown, io) => {
    const event = payload as { topicId: string; keyword: string; platform: string };
    await io.logger.info("Generating content", { topicId: event.topicId });
    return { topicId: event.topicId, status: "generated" };
  },
});
