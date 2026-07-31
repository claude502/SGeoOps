import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("internal clients page", () => {
  it("provides a client list and API-backed creation entry", async () => {
    const source = await readFile("src/app/(ops)/clients/page.tsx", "utf8");

    expect(source).toContain('"use client"');
    expect(source).toContain('fetch("/api/clients"');
    expect(source).toContain("New client");
    expect(source).toContain('method: "POST"');
    expect(source).toContain('aria-label="Refresh clients"');
  });
});
