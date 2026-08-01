import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSiteByHost: vi.fn(),
}));

vi.mock("@/lib/organization/repository", () => ({
  organizationRepository: {
    resolveSiteByHost: mocks.resolveSiteByHost,
  },
}));

import {
  isOpsHost,
  isTxpuroHost,
  normalizeLocaleFromGuidesSlug,
  resolvePublicSite,
  resolvePublicRoute,
  txpuroCanonicalUrl,
  txpuroGuidesPath,
} from "@/lib/site-context";

describe("site context helpers", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "");
  });

  afterEach(() => {
    mocks.resolveSiteByHost.mockReset();
    vi.unstubAllEnvs();
  });

  it("resolves public hosts from the seeded site repository when a database is configured", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://geo.example/sgeo");
    mocks.resolveSiteByHost.mockResolvedValue({
      workspaceId: "workspace_internal",
      clientId: "client_wing_heng",
      brandId: "brand_txpuro",
      siteId: "site_txpuro_com",
      name: "Txpuro",
      canonicalHost: "txpuro.com",
      originHosts: ["geo-origin.winghengtech.com"],
      siteType: "content",
      hostingMode: "hybrid",
      canonicalRules: { https: true, www: "redirect" },
      allowedPublishPaths: ["/guides"],
    });

    await expect(resolvePublicSite("TXPURO.COM:443")).resolves.toMatchObject({
      siteId: "site_txpuro_com",
      canonicalHost: "txpuro.com",
    });
    expect(mocks.resolveSiteByHost).toHaveBeenCalledWith("txpuro.com");
  });

  it("resolves the Txpuro guide route through the public-site resolver", async () => {
    await expect(
      resolvePublicRoute("txpuro.com", "/guides/pricing"),
    ).resolves.toEqual({
      siteId: "site_txpuro_com",
      locale: "zh-CN",
      slug: "pricing",
    });
  });

  it("does not resolve public routes for unknown hosts", async () => {
    await expect(
      resolvePublicRoute("unknown.example", "/guides/pricing"),
    ).resolves.toBeNull();
  });

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
