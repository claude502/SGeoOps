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

  it("blocks the expanded blacklist coverage set", () => {
    const blocked = ["暴动现场", "恐袭警告", "群体事件爆发", "选举舞弊证据", "种族冲突"];

    for (const keyword of blocked) {
      expect(isSafeKeyword(keyword)).toBe(false);
    }
  });

  it("allows clean business and compliance keywords", () => {
    const safe = [
      "LHDN e-Invoice deadline 2025",
      "中小企业税务合规",
      "电子发票系统对比",
      "Malaysia SME accounting software",
      "ERP integration guide",
    ];

    for (const keyword of safe) {
      expect(isSafeKeyword(keyword)).toBe(true);
    }
  });

  it("blocks mixed-script keywords when any blocked term appears", () => {
    expect(isSafeKeyword("latest 政变 news")).toBe(false);
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
