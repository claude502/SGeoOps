import { describe, expect, it } from "vitest";
import { isTxpuroHost, isOpsHost, normalizeLocaleFromGuidesSlug, txpuroCanonicalUrl, txpuroGuidesPath } from "@/lib/site-context";

describe("site context helpers", () => {
  it("builds guide paths inside the dedicated public namespace", () => {
    expect(txpuroGuidesPath("home", "zh-CN")).toBe("/guides");
    expect(txpuroGuidesPath("home", "en")).toBe("/guides/en");
    expect(txpuroGuidesPath("pricing", "zh-CN")).toBe("/guides/pricing");
    expect(txpuroGuidesPath("guides/what-is-myinvois", "en")).toBe("/guides/en/what-is-myinvois");
  });

  it("keeps canonical URLs on the public txpuro domain", () => {
    expect(txpuroCanonicalUrl("compare/txpuro-vs-myinvois-portal", "zh-CN")).toBe(
      "https://txpuro.com/guides/compare/txpuro-vs-myinvois-portal",
    );
  });

  it("parses english and chinese guide slugs", () => {
    expect(normalizeLocaleFromGuidesSlug(["en", "faq"])).toEqual({
      locale: "en",
      pathSegments: ["faq"],
    });
    expect(normalizeLocaleFromGuidesSlug(["compare", "txpuro-vs-manual-process"])).toEqual({
      locale: "zh-CN",
      pathSegments: ["compare", "txpuro-vs-manual-process"],
    });
  });

  it("recognises txpuro canonical and www hosts", () => {
    expect(isTxpuroHost("txpuro.com")).toBe(true);
    expect(isTxpuroHost("www.txpuro.com")).toBe(true);
    expect(isTxpuroHost("txpuro.com:3000")).toBe(true);
    expect(isTxpuroHost("evil.com")).toBe(false);
    expect(isTxpuroHost(null)).toBe(false);
    expect(isTxpuroHost(undefined)).toBe(false);
  });

  it("recognises ops hosts from env defaults", () => {
    expect(isOpsHost("wingheng.technology")).toBe(true);
    expect(isOpsHost("www.wingheng.technology")).toBe(true);
    expect(isOpsHost("txpuro.com")).toBe(false);
  });
});
