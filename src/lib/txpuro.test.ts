import { describe, expect, it } from "vitest";
import { txpuroPrompts, txpuroProject, txpuroStarterAssets, txpuroStructuredSections } from "@/lib/txpuro";

describe("txpuro workspace", () => {
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
});
