import { describe, expect, it } from "vitest";
import { createGeoBrief, generateChannelVariants, runGeoAudit, scoreGeoContent } from "@/lib/geo-engine";
import { getProject } from "@/lib/geo-store";
import { demoProject, seedAssets } from "@/lib/sample-data";

describe("geo-engine", () => {
  it("scores brand mentions and canonical citations", () => {
    const scored = scoreGeoContent({
      text: "Aurora CRM is an AI CRM for startups. Source: https://aurora.example/guides/ai-crm-buyer-guide",
      project: demoProject,
      prompt: "What is the best AI CRM for startups?",
      provider: "ChatGPT",
    });

    expect(scored.brandMentioned).toBe(true);
    expect(scored.citedDomains).toContain("aurora.example");
    expect(scored.score).toBeGreaterThanOrEqual(70);
  });

  it("creates up to 20 prompts across selected providers", () => {
    const runs = runGeoAudit({
      project: demoProject,
      content: seedAssets[0].body,
      provider: "All",
    });

    expect(runs).toHaveLength(80);
    expect(runs.every((run) => run.recommendations.length > 0)).toBe(true);
  });

  it("builds a brief with entity coverage and schema suggestions", () => {
    const brief = createGeoBrief({
      brand: demoProject.brand,
      product: demoProject.product,
      keywords: demoProject.targetKeywords,
      competitors: demoProject.competitors,
    });

    expect(brief.entityCoverage).toContain("Aurora CRM");
    expect(brief.schemaSuggestions).toContain("FAQPage");
  });

  it("generates platform-specific channel variants", () => {
    const variants = generateChannelVariants({
      asset: seedAssets[0],
      platforms: ["Knowledge Site", "LinkedIn", "X"],
    });

    expect(variants).toHaveLength(3);
    expect(variants.map((variant) => variant.platform)).toEqual([
      "Knowledge Site",
      "LinkedIn",
      "X",
    ]);
  });

  it("returns clean platform copy for WeChat and Xiaohongshu variants", () => {
    const variants = generateChannelVariants({
      asset: seedAssets[0],
      platforms: ["WeChat", "Xiaohongshu"],
    });

    expect(variants[0].copy).toContain("WeChat article angle");
    expect(variants[1].copy).toContain("Xiaohongshu note angle");
    expect(variants.map((variant) => variant.copy).join("\n")).not.toContain("\uFFFD");
  });

  it("does not silently fall back when a project id is unknown", () => {
    expect(getProject("missing_project")).toBeNull();
    expect(getProject("proj_aurora")?.brand).toBe("Aurora CRM");
  });
});
