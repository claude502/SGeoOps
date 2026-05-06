// @ts-expect-error - no type defs
import googleTrends from "google-trends-api";

export interface GoogleTrendResult {
  keyword: string;
  score: number;
  platform: "google";
  region: string;
}

export async function fetchGoogleTrends(geo = "MY"): Promise<GoogleTrendResult[]> {
  try {
    const raw = await googleTrends.dailyTrends({ geo });
    const data = JSON.parse(raw as string);
    const items: { title: { query: string } }[] =
      data?.default?.trendingSearchesDays?.[0]?.trendingSearches ?? [];

    return items.slice(0, 20).map((item, index) => ({
      keyword: item.title.query,
      score: Math.max(0, 100 - index * 5),
      platform: "google" as const,
      region: geo,
    }));
  } catch {
    return [];
  }
}
