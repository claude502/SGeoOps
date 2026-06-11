import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  db: {
    contentAsset: {
      findMany: mockFindMany,
    },
  },
}));

describe("GET /api/export-packages", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFindMany.mockReset();
  });

  it("returns export package summaries from public ready assets", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "asset_1",
        title: "Txpuro Guide",
        summary: "Summary",
        body: "Body",
        canonicalUrl: "https://txpuro.com/guides/txpuro-guide",
        sourceUrl: "https://txpuro.com/guides/txpuro-guide",
        publishedPath: "/guides/txpuro-guide",
        geoScore: 80,
        seoScore: 75,
        locale: "zh-CN",
        assetType: "guide-page",
        targetKeywords: ["einvoice"],
        faqs: [],
        createdAt: new Date("2026-06-11T10:00:00.000Z"),
        updatedAt: new Date("2026-06-11T11:00:00.000Z"),
        variants: [{ platform: "LinkedIn", copy: "copy", mediaAssets: [], metrics: [] }],
        trendTopic: { keyword: "LHDN e-Invoice", platform: "google", score: 88 },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/export-packages?status=ready"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      hasMore: false,
      items: [
        {
          id: "pkg_asset_1",
          contentAssetId: "asset_1",
          canonicalUrl: "https://txpuro.com/guides/txpuro-guide",
          recommendedPlatforms: ["LinkedIn"],
        },
      ],
    });
  });

  it("returns empty items for unsupported status filters", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/export-packages?status=claimed"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
