import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  listTxpuroPublicAssets: vi.fn(),
  resolvePublicSite: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("@/lib/site-context", () => ({
  resolvePublicSite: mocks.resolvePublicSite,
}));

vi.mock("@/lib/txpuro", () => ({
  listTxpuroPublicAssets: mocks.listTxpuroPublicAssets,
}));

import { GET } from "./route";

const txpuroSite = {
  siteId: "site_txpuro_com",
  canonicalHost: "txpuro.com",
};

describe("GET /llms.txt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers({ host: "txpuro.com" }));
  });

  it("uses the resolved Txpuro site to list public knowledge pages", async () => {
    mocks.resolvePublicSite.mockResolvedValue(txpuroSite);
    mocks.listTxpuroPublicAssets.mockResolvedValue([
      {
        canonicalUrl: "https://txpuro.com/guides/pricing",
        isPublic: true,
        assetType: "money-page",
      },
    ]);

    const response = await GET();

    expect(mocks.resolvePublicSite).toHaveBeenCalledWith("txpuro.com");
    expect(mocks.listTxpuroPublicAssets).toHaveBeenCalledWith("site_txpuro_com");
    await expect(response.text()).resolves.toContain(
      "https://txpuro.com/guides/pricing",
    );
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
  ])("fails closed for %s", async (_caseName, arrange) => {
    arrange();

    const response = await GET();

    expect(mocks.listTxpuroPublicAssets).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("");
  });
});
