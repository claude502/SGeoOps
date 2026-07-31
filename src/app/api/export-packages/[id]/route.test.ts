import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindUnique = vi.fn();

vi.mock("@/lib/authorization", () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  requireAccessScope: vi.fn().mockResolvedValue({
    actorId: "viewer_a",
    workspaceId: "workspace_internal",
    role: "Viewer",
    clientIds: ["client_a"],
  }),
  requireRole: vi.fn(),
}));

vi.mock("@/lib/business/repository", () => ({
  PrismaBusinessRepository: class {
    getExportAsset() {
      return mockFindUnique();
    }
  },
}));

describe("GET /api/export-packages/[id]", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFindUnique.mockReset();
  });

  it("returns a fully built export package", async () => {
    mockFindUnique.mockResolvedValue({
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
      faqs: [{ question: "Q", answer: "A" }],
      createdAt: new Date("2026-06-11T10:00:00.000Z"),
      updatedAt: new Date("2026-06-11T11:00:00.000Z"),
      variants: [
        {
          platform: "LinkedIn",
          copy: "copy",
          mediaAssets: [],
          metrics: [
            {
              impressions: 10,
              clicks: 2,
              shares: 1,
              recordedAt: new Date("2026-06-11T12:00:00.000Z"),
            },
          ],
        },
      ],
      trendTopic: { keyword: "LHDN e-Invoice", platform: "google", score: 88 },
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/export-packages/pkg_asset_1"), {
      params: Promise.resolve({ id: "pkg_asset_1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "pkg_asset_1",
      contentAssetId: "asset_1",
      variants: {
        LinkedIn: {
          copy: "copy",
        },
      },
      faq: [{ question: "Q", answer: "A" }],
    });
  });

  it("returns 404 when the asset is missing", async () => {
    mockFindUnique.mockResolvedValue(null);

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/export-packages/pkg_missing"), {
      params: Promise.resolve({ id: "pkg_missing" }),
    });

    expect(response.status).toBe(404);
  });
});
