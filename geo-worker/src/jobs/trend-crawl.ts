import { cronTrigger } from "@trigger.dev/sdk";

import { client } from "../trigger";
import { failLegacyWorker } from "./legacy-worker-disabled";

client.defineJob({
  id: "trend-crawl",
  name: "热搜抓取（每15分钟）",
  version: "1.0.0",
  trigger: cronTrigger({ cron: "*/15 * * * *" }),
  run: async () => {
    failLegacyWorker();
  },
});
