import { describe, expect, it } from "vitest";
import { buildContentAsset, contentAssetInputSchema } from "@/lib/content-assets";

describe("content asset input", () => {
  it("accepts blank optional source URL and falls back to canonical URL", () => {
    const parsed = contentAssetInputSchema.parse({
      title: "  Wingheng GEO page  ",
      body: "  Real article body.  ",
      brandEntity: "  Wingheng  ",
      canonicalUrl: " https://wingheng.technology/geo ",
      sourceUrl: "",
      targetKeywords: " GEO, AI search, GEO ",
      owner: "",
    });

    const asset = buildContentAsset(parsed, new Date("2026-05-04T00:00:00.000Z"));

    expect(asset.title).toBe("Wingheng GEO page");
    expect(asset.body).toBe("Real article body.");
    expect(asset.brandEntity).toBe("Wingheng");
    expect(asset.sourceUrl).toBe("https://wingheng.technology/geo");
    expect(asset.targetKeywords).toEqual(["GEO", "AI search", "GEO"]);
    expect(asset.owner).toBe("GEO Ops");
    expect(asset.id).toBe("asset_wingheng-geo-page_zh-cn_1777852800000");
  });

  it("requires at least one target keyword at the API boundary", () => {
    const parsed = contentAssetInputSchema.safeParse({
      title: "Wingheng GEO page",
      body: "Real article body.",
      brandEntity: "Wingheng",
      canonicalUrl: "https://wingheng.technology/geo",
      targetKeywords: " , ",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.targetKeywords?.[0]).toContain(
        "At least one target keyword",
      );
    }
  });

  it("rejects non-http canonical and source URLs", () => {
    const canonical = contentAssetInputSchema.safeParse({
      title: "Wingheng GEO page",
      body: "Real article body.",
      brandEntity: "Wingheng",
      canonicalUrl: "ftp://wingheng.technology/geo",
      targetKeywords: "GEO",
    });
    const source = contentAssetInputSchema.safeParse({
      title: "Wingheng GEO page",
      body: "Real article body.",
      brandEntity: "Wingheng",
      canonicalUrl: "https://wingheng.technology/geo",
      sourceUrl: "mailto:ops@wingheng.technology",
      targetKeywords: "GEO",
    });

    expect(canonical.success).toBe(false);
    expect(source.success).toBe(false);
  });

  it("builds public txpuro assets with locale, slug, and publish defaults", () => {
    const parsed = contentAssetInputSchema.parse({
      title: "What is MyInvois",
      body: "Direct answer.\n\n## Workflow\n\nUseful content.",
      brandEntity: "Txpuro",
      canonicalUrl: "https://txpuro.com/guides/what-is-myinvois",
      targetKeywords: "MyInvois, Malaysia e-Invoice",
      locale: "en",
      slug: "guides/what-is-myinvois",
      assetType: "guide-page",
      audience: "SMEs",
      isPublic: true,
    });

    const asset = buildContentAsset(parsed, new Date("2026-05-05T00:00:00.000Z"));

    expect(asset.locale).toBe("en");
    expect(asset.slug).toBe("guides/what-is-myinvois");
    expect(asset.publishTarget).toBe("txpuro");
    expect(asset.isPublic).toBe(true);
    expect(asset.publishedPath).toBe("/en/guides/what-is-myinvois");
    expect(asset.schemaType).toBe("article");
  });
});
