import { PrismaClient } from "@prisma/client";
import { cronTrigger, type JobIO } from "@trigger.dev/sdk";

import { fetchWeiboTrending } from "../clients/firecrawl";
import { fetchGoogleTrends } from "../clients/google-trends";
import { client } from "../trigger";

const db = new PrismaClient();

async function configuredOwnership() {
  const clientId = process.env.SGEO_CLIENT_ID?.trim();
  const brandId = process.env.SGEO_BRAND_ID?.trim();
  const siteId = process.env.SGEO_SITE_ID?.trim();
  if (!clientId || !brandId || !siteId) {
    throw new Error("Explicit SGEO ownership is required for trend crawling");
  }
  const site = await db.site.findFirst({
    where: {
      id: siteId,
      brandId,
      brand: { clientId },
    },
    select: { id: true },
  });
  if (!site) {
    throw new Error("Configured SGEO ownership chain was not found");
  }
  return { clientId, brandId, siteId };
}

client.defineJob({
  id: "trend-crawl",
  name: "热搜抓取（每15分钟）",
  version: "1.0.0",
  trigger: cronTrigger({ cron: "*/15 * * * *" }),
  run: async (_payload: unknown, io: JobIO) => {
    await io.logger.info("Trend crawl started");
    const ownership = await configuredOwnership();

    const [google, weibo] = await Promise.allSettled([
      fetchGoogleTrends("MY"),
      fetchWeiboTrending(),
    ]);

    const all = [
      ...(google.status === "fulfilled" ? google.value : []),
      ...(weibo.status === "fulfilled" ? weibo.value : []),
    ];

    if (all.length > 0) {
      await Promise.allSettled(
        all.map(async (result) => {
          const existing = await db.trendTopic.findFirst({
            where: {
              ...ownership,
              keyword: result.keyword,
              platform: result.platform,
            },
            select: { id: true },
          });

          if (existing) {
            const updated = await db.trendTopic.updateMany({
              where: { id: existing.id, ...ownership },
              data: {
                score: result.score,
                capturedAt: new Date(),
              },
            });
            if (updated.count !== 1) {
              throw new Error("Owned trend topic was not updated");
            }
            return;
          }

          return db.trendTopic.create({
            data: {
              ...ownership,
              keyword: result.keyword,
              platform: result.platform,
              score: result.score,
              region: "region" in result ? String(result.region) : "CN",
              sourceType: "crawler",
              capturedAt: new Date(),
              status: "pending",
            },
          });
        }),
      );
    }

    await io.logger.info("Crawl complete", { count: all.length });
    return { crawled: all.length };
  },
});
