import { describe, expect, it } from "vitest";
import { buildContentAsset, contentAssetInputSchema } from "@/lib/content-assets";
import { contentAssetTypes } from "@/types/geo";

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
    expect(asset.id).toMatch(/^asset_wingheng-geo-page_zh-cn_[0-9a-f]{8}$/);
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
    expect(asset.publishedPath).toBe("/guides/en/what-is-myinvois");
    expect(asset.schemaType).toBe("article");
  });

  it("truncates slugs generated from titles longer than 48 chars", () => {
    const parsed = contentAssetInputSchema.parse({
      title: "This is a very long title that definitely exceeds the 48 character limit for slugs",
      body: "body",
      brandEntity: "Test",
      canonicalUrl: "https://example.com/page",
      targetKeywords: "test",
    });
    const asset = buildContentAsset(parsed);
    expect(asset.slug!.length).toBeLessThanOrEqual(48);
  });

  it("assigns correct schema types for every asset type", () => {
    const base = {
      title: "Test",
      body: "body",
      brandEntity: "Test",
      canonicalUrl: "https://example.com/page",
      targetKeywords: "test",
    };
    const expected: Record<string, string> = {
      "faq-page": "faq",
      "money-page": "product",
      "feature-page": "product",
      "guide-page": "article",
      "compare-page": "article",
    };
    for (const assetType of contentAssetTypes) {
      const parsed = contentAssetInputSchema.parse({ ...base, assetType });
      const asset = buildContentAsset(parsed);
      expect(asset.schemaType).toBe(expected[assetType]);
    }
  });

  it("generates unique IDs for concurrent builds of the same asset", () => {
    const parsed = contentAssetInputSchema.parse({
      title: "Same Title",
      body: "body",
      brandEntity: "Test",
      canonicalUrl: "https://example.com/page",
      targetKeywords: "test",
    });
    const ids = Array.from({ length: 20 }, () => buildContentAsset(parsed).id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(20);
  });
});
