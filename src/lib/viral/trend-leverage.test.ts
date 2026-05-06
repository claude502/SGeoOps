import { describe, expect, it } from "vitest";

import { buildLeveragePrompt, isSafeKeyword } from "./trend-leverage";

describe("isSafeKeyword", () => {
  it("passes clean keywords", () => {
    expect(isSafeKeyword("Malaysia e-Invoice system")).toBe(true);
    expect(isSafeKeyword("电子发票 中小企业")).toBe(true);
  });

  it("blocks blacklisted keywords", () => {
    expect(isSafeKeyword("政变相关词")).toBe(false);
    expect(isSafeKeyword("暴动事件")).toBe(false);
  });
});

describe("buildLeveragePrompt", () => {
  it("contains keyword, product, and angle instruction", () => {
    const prompt = buildLeveragePrompt({
      keyword: "LHDN e-Invoice deadline",
      productName: "Txpuro",
      brand: "Txpuro",
      platform: "linkedin",
    });

    expect(prompt).toContain("LHDN e-Invoice deadline");
    expect(prompt).toContain("Txpuro");
    expect(prompt).toContain("3个借势角度");
  });
});
