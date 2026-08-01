import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Trigger configuration", () => {
  it("uses the official Trigger 4.5.9 Puppeteer build extension for Unlighthouse", async () => {
    const config = await readFile(new URL("./trigger.config.ts", import.meta.url), "utf8");

    expect(config).toContain('@trigger.dev/build/extensions/puppeteer');
    expect(config).toContain("extensions: [puppeteer()]");
  });
});
