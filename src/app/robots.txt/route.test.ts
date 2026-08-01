import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  resolvePublicSite: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("@/lib/site-context", () => ({
  resolvePublicSite: mocks.resolvePublicSite,
}));

import { GET } from "./route";

const txpuroSite = {
  siteId: "site_txpuro_com",
  canonicalHost: "txpuro.com",
};

describe("GET /robots.txt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers({ host: "txpuro.com" }));
  });

  it("uses the resolved Txpuro site before allowing crawl access", async () => {
    mocks.resolvePublicSite.mockResolvedValue(txpuroSite);

    const response = await GET();

    expect(mocks.resolvePublicSite).toHaveBeenCalledWith("txpuro.com");
    await expect(response.text()).resolves.toContain("Allow: /guides/");
  });

  it.each([
    ["unknown hosts", () => mocks.resolvePublicSite.mockResolvedValue(null)],
    ["other public sites", () =>
      mocks.resolvePublicSite.mockResolvedValue({
        ...txpuroSite,
        siteId: "site_other",
      })],
    ["resolver failures", () =>
      mocks.resolvePublicSite.mockRejectedValue(new Error("database unavailable"))],
  ])("disallows crawling for %s", async (_caseName, arrange) => {
    arrange();

    const response = await GET();

    await expect(response.text()).resolves.toBe("User-agent: *\nDisallow: /\n");
  });
});
