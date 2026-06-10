import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindUnique = vi.fn();
const mockFindFirst = vi.fn();
const mockCreate = vi.fn();
const mockCount = vi.fn();
const mockSaveChannelVariants = vi.fn();

vi.mock("@/lib/prisma", () => ({
  db: {
    trendTopic: { findUnique: mockFindUnique },
    contentAsset: { findFirst: mockFindFirst, create: mockCreate },
    channelVariant: { count: mockCount },
  },
  isDatabaseConfigured: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/geo-persistence", () => ({
  saveChannelVariants: mockSaveChannelVariants,
}));

describe("POST /api/internal/content-generate", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFindUnique.mockReset();
    mockFindFirst.mockReset();
    mockCreate.mockReset();
    mockCount.mockReset();
    mockSaveChannelVariants.mockReset();
    mockFindFirst.mockResolvedValue(null);
    mockCount.mockResolvedValue(0);
    mockSaveChannelVariants.mockResolvedValue([]);
  });

  it("returns 400 when required fields are missing", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/internal/content-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword: "Malaysia e-Invoice" }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for unsafe keywords", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/internal/content-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topicId: "topic_1",
          keyword: "政变 新闻",
          platform: "weibo",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("unsafe"),
    });
  });

  it("returns 404 when the trend topic is not found", async () => {
    mockFindUnique.mockResolvedValue(null);

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/internal/content-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topicId: "topic_404",
          keyword: "LHDN e-Invoice deadline",
          platform: "linkedin",
        }),
      }),
    );

    expect(response.status).toBe(404);
  });

  it("creates a content asset and returns contentAssetId with variantCount", async () => {
    mockFindUnique.mockResolvedValue({
      id: "topic_ok",
      keyword: "LHDN e-Invoice deadline",
      platform: "linkedin",
      score: 80,
      region: "MY",
    });
    mockCreate.mockResolvedValue({ id: "asset_created_1" });
    mockSaveChannelVariants.mockImplementation(async (variants) => variants);

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/internal/content-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topicId: "topic_ok",
          keyword: "LHDN e-Invoice deadline",
          platform: "linkedin",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      contentAssetId: "asset_created_1",
      variantCount: expect.any(Number),
      geoScore: expect.any(Number),
      seoScore: expect.any(Number),
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockSaveChannelVariants).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0]?.data?.canonicalUrl).toBe(
      "https://txpuro.com/guides/trend/topic_ok",
    );
  });

  it("reuses an existing generated asset instead of creating duplicates", async () => {
    mockFindUnique.mockResolvedValue({
      id: "topic_existing",
      keyword: "LHDN e-Invoice deadline",
      platform: "linkedin",
      score: 80,
      region: "MY",
    });
    mockFindFirst.mockResolvedValue({
      id: "asset_existing_1",
      title: "Existing asset",
      summary: "Existing summary",
      body: "Existing body",
      brandEntity: "Txpuro",
      geoScore: 76,
      seoScore: 71,
    });
    mockCount.mockResolvedValue(4);

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/internal/content-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topicId: "topic_existing",
          keyword: "LHDN e-Invoice deadline",
          platform: "linkedin",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      contentAssetId: "asset_existing_1",
      variantCount: 4,
      reused: true,
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSaveChannelVariants).not.toHaveBeenCalled();
  });
});
