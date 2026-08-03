import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthorizationError, type AccessScope } from "@/lib/authorization";
import { ScopedOrganizationError } from "@/lib/organization/repository";
import type { PublicSeoReport } from "@/lib/seo/report-presenter";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  notFound: vi.fn(),
  requireAccessScope: vi.fn(),
  loadScopedSeoReport: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authorization")>()),
  requireAccessScope: mocks.requireAccessScope,
}));
vi.mock("@/lib/seo/report-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/report-service")>()),
  loadScopedSeoReport: mocks.loadScopedSeoReport,
}));

const access: AccessScope = {
  actorId: "viewer_a",
  workspaceId: "workspace_internal",
  role: "Viewer",
  clientIds: ["client_a"],
};

const report: PublicSeoReport = {
  siteId: "site_a",
  siteMarketId: "market_a",
  range: { from: "2026-07-01", to: "2026-07-31" },
  baseline: null,
  latest: null,
  anchorPolicy: "eligible-source-runs-by-finished-at",
  formulaVersion: "seo-v1",
  metrics: [],
  coverage: [],
  runs: [],
  opportunities: [],
  isEmpty: true,
};

describe("site SEO page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers());
    mocks.notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    mocks.requireAccessScope.mockResolvedValue(access);
    mocks.loadScopedSeoReport.mockResolvedValue({
      clientId: "client_a",
      brandId: "brand_a",
      siteMarketId: "market_a",
      site: {
        id: "site_a",
        name: "Site A",
        canonicalHost: "site-a.example.com",
      },
      markets: [{
        id: "market_a",
        country: "MY",
        locale: "en-MY",
      }],
      report,
    });
  });

  it("server-renders preserved filters and the scoped report empty state", async () => {
    const { default: SiteSeoPage } = await import("./page");
    const markup = renderToStaticMarkup(await SiteSeoPage({
      params: Promise.resolve({ siteId: "site_a" }),
      searchParams: Promise.resolve({
        start: "2026-07-01",
        end: "2026-07-31",
        siteMarketId: "market_a",
      }),
    }));

    expect(markup).toContain("Site A");
    expect(markup).toContain("SEO operations");
    expect(markup).toContain('name="start"');
    expect(markup).toContain('value="2026-07-01"');
    expect(markup).toContain('name="siteMarketId"');
    expect(markup).toContain('value="market_a" selected=""');
    expect(markup).toContain("No SEO report data for this scope and date range");
    expect(mocks.loadScopedSeoReport).toHaveBeenCalledWith(
      access,
      "site_a",
      expect.objectContaining({ siteMarketId: "market_a" }),
    );
  });

  it.each([
    new AuthorizationError("UNAUTHENTICATED"),
    new ScopedOrganizationError("RESOURCE_NOT_FOUND"),
  ])("fails closed through notFound for scoped access failures", async (error) => {
    const { default: SiteSeoPage } = await import("./page");
    if (error instanceof AuthorizationError) {
      mocks.requireAccessScope.mockRejectedValue(error);
    } else {
      mocks.loadScopedSeoReport.mockRejectedValue(error);
    }

    await expect(SiteSeoPage({
      params: Promise.resolve({ siteId: "site_client_b" }),
      searchParams: Promise.resolve({ start: "2026-07-01", end: "2026-07-31" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows a recoverable filter error without querying report data", async () => {
    const { default: SiteSeoPage } = await import("./page");
    const markup = renderToStaticMarkup(await SiteSeoPage({
      params: Promise.resolve({ siteId: "site_a" }),
      searchParams: Promise.resolve({
        start: ["2026-07-01", "2026-07-02"],
        end: "2026-07-31",
      }),
    }));

    expect(markup).toContain("Invalid report filters");
    expect(markup).toContain('/sites/site_a/seo');
    expect(mocks.loadScopedSeoReport).not.toHaveBeenCalled();
  });
});
