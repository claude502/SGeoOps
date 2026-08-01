import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  db: {},
  getPrisma: () => ({
    contentAsset: {
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
    },
  }),
  isDatabaseConfigured: () => true,
}));

import { PrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";

function publicAsset(id: string, siteId: string) {
  return {
    id,
    siteId,
    title: id,
    body: "Body",
    summary: "Summary",
    brandEntity: "Brand",
    sourceUrl: "https://example.com/source",
    targetKeywords: [],
    canonicalUrl: "https://example.com/guides/pricing",
    status: "Ready",
    geoScore: 80,
    owner: "operator",
    sourceSystem: "geo_ops",
    externalUrl: null,
    publishedAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    slug: "pricing",
    locale: "zh-CN",
    assetType: "guide-page",
    audience: null,
    seoTitle: null,
    metaDescription: null,
    faqs: [],
    schemaType: "article",
    ctaMode: "self_signup",
    publishTarget: "txpuro",
    isPublic: true,
    publishedPath: "/guides/pricing",
  };
}

function matchesPublicWhere(
  asset: ReturnType<typeof publicAsset>,
  where: Record<string, unknown>,
) {
  return (
    asset.siteId === where.siteId &&
    asset.slug === where.slug &&
    asset.locale === where.locale &&
    asset.publishTarget === where.publishTarget &&
    asset.isPublic === where.isPublic
  );
}

describe("PrismaGeoFlowBridgeRepository public content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not return or list a foreign site with the same public slug", async () => {
    const foreign = publicAsset("asset_foreign", "site_other");
    const txpuro = publicAsset("asset_txpuro", "site_txpuro_com");
    const assets = [foreign, txpuro];
    mocks.findFirst.mockImplementation(async ({ where }) =>
      assets.find((asset) => matchesPublicWhere(asset, where)) ?? null,
    );
    mocks.findMany.mockImplementation(async ({ where }) =>
      assets.filter((asset) => matchesPublicWhere(asset, {
        ...where,
        slug: "pricing",
        locale: "zh-CN",
      })),
    );

    const repository = new PrismaGeoFlowBridgeRepository();

    await expect(
      repository.findPublicContentAsset(
        "site_txpuro_com",
        "pricing",
        "zh-CN",
        "txpuro",
      ),
    ).resolves.toMatchObject({ id: "asset_txpuro" });
    await expect(
      repository.listPublicContentAssets("site_txpuro_com", "txpuro"),
    ).resolves.toEqual([expect.objectContaining({ id: "asset_txpuro" })]);
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          siteId: "site_txpuro_com",
          slug: "pricing",
          locale: "zh-CN",
          publishTarget: "txpuro",
          isPublic: true,
        },
      }),
    );
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          siteId: "site_txpuro_com",
          publishTarget: "txpuro",
          isPublic: true,
        },
      }),
    );
  });
});
