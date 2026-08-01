import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findPublicContentAsset: vi.fn(),
  listContentAssets: vi.fn(),
  listPublicContentAssets: vi.fn(),
}));

vi.mock("@/lib/geoflow/repository", () => ({
  PrismaGeoFlowBridgeRepository: class {
    findPublicContentAsset = mocks.findPublicContentAsset;
    listContentAssets = mocks.listContentAssets;
    listPublicContentAssets = mocks.listPublicContentAssets;
  },
}));

vi.mock("@/lib/prisma", () => ({
  db: {},
  isDatabaseConfigured: () => Boolean(process.env.DATABASE_URL?.trim()),
}));

import {
  getTxpuroPublicAsset,
  listTxpuroPublicAssets,
  txpuroPrompts,
  txpuroProject,
  txpuroStarterAssets,
  txpuroStructuredSections,
} from "@/lib/txpuro";

const getSitePublicAsset = getTxpuroPublicAsset as unknown as (
  siteId: string,
  slug: string,
  locale: "zh-CN" | "en",
) => ReturnType<typeof getTxpuroPublicAsset>;

const listSitePublicAssets = listTxpuroPublicAssets as unknown as (
  siteId: string,
) => ReturnType<typeof listTxpuroPublicAssets>;

describe("txpuro workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("provides the configured project and prompt set", () => {
    expect(txpuroProject.brand).toBe("Txpuro");
    expect(txpuroProject.canonicalDomain).toBe("txpuro.com");
    expect(txpuroPrompts).toHaveLength(20);
  });

  it("builds bilingual public starter assets", () => {
    const assets = txpuroStarterAssets();
    const homeZh = assets.find((asset) => asset.slug === "home" && asset.locale === "zh-CN");
    const homeEn = assets.find((asset) => asset.slug === "home" && asset.locale === "en");
    const guideZh = assets.find((asset) => asset.slug === "guides/what-is-myinvois" && asset.locale === "zh-CN");

    expect(homeZh?.isPublic).toBe(true);
    expect(homeZh?.publishTarget).toBe("txpuro");
    expect(homeZh?.publishedPath).toBe("/guides");
    expect(homeEn?.publishedPath).toBe("/guides/en");
    expect(guideZh?.canonicalUrl).toBe("https://txpuro.com/guides/what-is-myinvois");
    expect(assets.some((asset) => asset.slug === "faq" && asset.locale === "en")).toBe(true);
  });

  it("parses structured sections from markdown-like content", () => {
    const sections = txpuroStructuredSections("## Direct answer\n\nLine one.\n\n## Workflow\n\nLine two.");

    expect(sections).toEqual([
      { title: "Direct answer", paragraphs: ["Line one."] },
      { title: "Workflow", paragraphs: ["Line two."] },
    ]);
  });

  it("uses the resolved site for public database lookup and listing", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://geo.example/sgeo");
    const databaseAsset = {
      ...txpuroStarterAssets()[0]!,
      id: "asset_database_txpuro",
      slug: "pricing",
      locale: "zh-CN" as const,
      title: "Database Txpuro pricing",
    };
    const foreignAsset = {
      ...databaseAsset,
      id: "asset_foreign",
      title: "Foreign pricing",
    };

    mocks.findPublicContentAsset.mockImplementation(
      async (siteId: string, slug: string) =>
        siteId === "site_txpuro_com" && slug === "pricing"
          ? databaseAsset
          : null,
    );
    mocks.listContentAssets.mockResolvedValue([foreignAsset]);
    mocks.listPublicContentAssets.mockResolvedValue([databaseAsset]);

    await expect(
      getSitePublicAsset("site_txpuro_com", "pricing", "zh-CN"),
    ).resolves.toMatchObject({ id: "asset_database_txpuro" });
    await expect(listSitePublicAssets("site_txpuro_com")).resolves.toEqual([
      expect.objectContaining({ id: "asset_database_txpuro" }),
    ]);
    expect(mocks.findPublicContentAsset).toHaveBeenCalledWith(
      "site_txpuro_com",
      "pricing",
      "zh-CN",
      "txpuro",
    );
    expect(mocks.listPublicContentAssets).toHaveBeenCalledWith(
      "site_txpuro_com",
      "txpuro",
    );
    expect(mocks.listContentAssets).not.toHaveBeenCalled();
  });

  it("uses static starter assets only when no database is configured", async () => {
    await expect(
      getSitePublicAsset("site_txpuro_com", "pricing", "zh-CN"),
    ).resolves.toMatchObject({ slug: "pricing", locale: "zh-CN" });
  });

  it("does not use the Txpuro starter fallback for another site", async () => {
    await expect(
      getSitePublicAsset("site_other", "pricing", "zh-CN"),
    ).resolves.toBeNull();
    await expect(listSitePublicAssets("site_other")).resolves.toEqual([]);
  });
});
