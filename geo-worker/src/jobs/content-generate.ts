import { eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

import { client } from "../trigger";
import { failLegacyWorker } from "./legacy-worker-disabled";

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
  run: async () => {
    failLegacyWorker();
  },
});
