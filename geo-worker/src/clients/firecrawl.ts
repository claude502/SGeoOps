import FirecrawlApp from "@mendable/firecrawl-js";

const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY ?? "" });

export interface WeiboTrendResult {
  keyword: string;
  score: number;
  platform: "weibo";
  region: "CN";
}

export async function fetchWeiboTrending(): Promise<WeiboTrendResult[]> {
  try {
    const result = await firecrawl.scrapeUrl("https://s.weibo.com/top/summary", {
      formats: ["extract"],
      extract: {
        schema: {
          type: "object",
          properties: {
            trends: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rank: { type: "number" },
                  keyword: { type: "string" },
                },
              },
            },
          },
        },
      },
    });

    const trends = (result.extract as { trends?: { rank: number; keyword: string }[] })?.trends ?? [];

    return trends.slice(0, 20).map((trend) => ({
      keyword: trend.keyword,
      score: Math.max(0, 100 - (trend.rank - 1) * 5),
      platform: "weibo" as const,
      region: "CN" as const,
    }));
  } catch {
    return [];
  }
}
