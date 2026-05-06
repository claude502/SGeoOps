import { describe, expect, it } from "vitest";

import { scoreDualContent, scoreSeoContent } from "./dual-optimizer";

describe("scoreSeoContent", () => {
  it("returns higher score when keyword in title and body", () => {
    const result = scoreSeoContent({
      title: "Malaysia e-Invoice System Guide",
      body: "The Malaysia e-Invoice system helps SMEs comply with LHDN. This Malaysia e-Invoice system is essential for businesses.",
      targetKeywords: ["Malaysia e-Invoice system"],
      locale: "en",
    });

    expect(result.score).toBeGreaterThan(50);
    expect(result.keywordDensity).toBeGreaterThan(0);
    expect(result.titleHasKeyword).toBe(true);
  });

  it("returns 0 density when no keywords match", () => {
    const result = scoreSeoContent({
      title: "Hello World",
      body: "Some unrelated content here.",
      targetKeywords: ["Malaysia e-Invoice system"],
      locale: "en",
    });

    expect(result.keywordDensity).toBe(0);
  });
});

describe("scoreDualContent", () => {
  it("returns geoScore and seoScore both between 0-100", () => {
    const result = scoreDualContent({
      title: "Txpuro Malaysia e-Invoice",
      body: "Txpuro is a Malaysia e-Invoice system for SMEs integrating with MyInvois LHDN.",
      targetKeywords: ["Malaysia e-Invoice"],
      project: {
        id: "test",
        name: "Txpuro",
        brand: "Txpuro",
        product: "e-Invoice System",
        locale: "en",
        competitors: ["MyInvois Portal"],
        targetKeywords: ["Malaysia e-Invoice"],
        canonicalDomain: "txpuro.com",
      },
      prompt: "best Malaysia e-Invoice system for SMEs",
      provider: "ChatGPT",
    });

    expect(result.geoScore).toBeGreaterThanOrEqual(0);
    expect(result.geoScore).toBeLessThanOrEqual(100);
    expect(result.seoScore).toBeGreaterThanOrEqual(0);
    expect(result.seoScore).toBeLessThanOrEqual(100);
  });
});
