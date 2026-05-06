import { cronTrigger } from "@trigger.dev/sdk";

import { client } from "../trigger";

client.defineJob({
  id: "seo-audit",
  name: "技术 SEO 巡检（每日凌晨3点）",
  version: "1.0.0",
  trigger: cronTrigger({ cron: "0 3 * * *" }),
  run: async (_payload: unknown, io) => {
    await io.logger.info("SEO audit started");
    return { audited: 0 };
  },
});
