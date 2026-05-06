import { describe, expect, it } from "vitest";

import { buildTemplatePrompt, getTemplate, VIRAL_TEMPLATES } from "./templates";

describe("getTemplate", () => {
  it("returns template by id", () => {
    expect(getTemplate("contrast-reveal")?.id).toBe("contrast-reveal");
  });

  it("returns undefined for unknown id", () => {
    expect(getTemplate("nonexistent")).toBeUndefined();
  });
});

describe("buildTemplatePrompt", () => {
  it("includes product name, keyword, and hook instruction", () => {
    const template = getTemplate("contrast-reveal");
    const prompt = buildTemplatePrompt(template!, {
      productName: "Txpuro",
      keyword: "Malaysia e-Invoice",
      platform: "xiaohongshu",
    });

    expect(prompt).toContain("Txpuro");
    expect(prompt).toContain("Malaysia e-Invoice");
    expect(prompt).toContain(template!.hook);
  });
});

describe("VIRAL_TEMPLATES", () => {
  it("has at least 3 templates, each with id hook and platforms", () => {
    expect(VIRAL_TEMPLATES.length).toBeGreaterThanOrEqual(3);

    for (const template of VIRAL_TEMPLATES) {
      expect(template.id).toBeTruthy();
      expect(template.hook).toBeTruthy();
      expect(template.platforms.length).toBeGreaterThan(0);
    }
  });
});
