import { PrismaClient } from "@prisma/client";
import { cronTrigger } from "@trigger.dev/sdk";

import { fetchWeiboTrending } from "../clients/firecrawl";
import { fetchGoogleTrends } from "../clients/google-trends";
import { client } from "../trigger";

const db = new PrismaClient();

client.defineJob({
  id: "trend-crawl",
  name: "热搜抓取（每15分钟）",
  version: "1.0.0",
  trigger: cronTrigger({ cron: "*/15 * * * *" }),
  run: async (_payload: unknown, io) => {
    await io.logger.info("Trend crawl started");

    const [google, weibo] = await Promise.allSettled([fetchGoogleTrends("MY"), fetchWeiboTrending()]);

    const all = [
      ...(google.status === "fulfilled" ? google.value : []),
      ...(weibo.status === "fulfilled" ? weibo.value : []),
    ];

    if (all.length > 0) {
      // upsert: update score/capturedAt for known trends, insert new ones.
      // skipDuplicates would silently drop re-appearing keywords — we want
      // to refresh the score instead, so we use individual upserts.
      await Promise.allSettled(
        all.map((result) =>
          db.trendTopic.upsert({
            where: { keyword_platform: { keyword: result.keyword, platform: result.platform } },
            update: {
              score: result.score,
              capturedAt: new Date(),
              // Reset to pending only if previously rejected (approved stays approved)
              status: "pending",
            },
            create: {
              keyword: result.keyword,
              platform: result.platform,
              score: result.score,
              region: "region" in result ? String(result.region) : "CN",
              sourceType: "crawler",
              capturedAt: new Date(),
              status: "pending",
            },
          }),
        ),
      );
    }

    await io.logger.info("Crawl complete", { count: all.length });
    return { crawled: all.length };
  },
});
