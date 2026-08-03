import { describe, expect, it, vi } from "vitest";

import type { AccessScope } from "@/lib/authorization";
import {
  loadScopedSeoReport,
  parseSeoReportFilters,
  SeoReportRequestError,
} from "./report-service";

const access: AccessScope = {
  actorId: "operator_a",
  workspaceId: "workspace_internal",
  role: "Viewer",
  clientIds: ["client_a"],
};

describe("SEO report service", () => {
  it("accepts exact calendar filters and derives timestamps", () => {
    const filters = parseSeoReportFilters(new URLSearchParams({
      start: "2026-07-01",
      end: "2026-07-31",
      siteMarketId: "market_a",
    }));

    expect(filters).toEqual({
      from: "2026-07-01",
      to: "2026-07-31",
      startAt: "2026-07-01T00:00:00.000Z",
      endAt: "2026-07-31T23:59:59.999Z",
      siteMarketId: "market_a",
    });
  });

  it("uses a deterministic 30-day default when both dates are omitted", () => {
    const filters = parseSeoReportFilters(
      new URLSearchParams(),
      new Date("2026-08-03T10:00:00.000Z"),
    );

    expect(filters).toMatchObject({
      from: "2026-07-05",
      to: "2026-08-03",
      siteMarketId: null,
    });
  });

  it("treats the form's empty market option as an omitted site-level scope", () => {
    const filters = parseSeoReportFilters(new URLSearchParams({
      start: "2026-07-01",
      end: "2026-07-31",
      siteMarketId: "",
    }));

    expect(filters.siteMarketId).toBeNull();
  });

  it.each([
    new URLSearchParams("start=2026-07-01&start=2026-07-02&end=2026-07-31"),
    new URLSearchParams("start=2026-07-01&end=2026-07-31&clientId=client_b"),
    new URLSearchParams("start=2026-02-30&end=2026-03-02"),
    new URLSearchParams("start=2026-07-01"),
    new URLSearchParams("start=2025-01-01&end=2026-07-31"),
    new URLSearchParams("start=2026-07-01&end=2026-07-31&siteMarketId=%20market_a%20"),
  ])("rejects malformed, duplicated, injected, or excessive filters", (params) => {
    expect(() => parseSeoReportFilters(params)).toThrow(SeoReportRequestError);
  });

  it("passes only relationship-derived ownership to the report query", async () => {
    const getSeoSiteContext = vi.fn().mockResolvedValue({
      clientId: "client_a",
      brandId: "brand_a",
      siteMarketId: "market_a",
      site: { id: "site_a", name: "Site A" },
      markets: [],
    });
    const getReport = vi.fn().mockResolvedValue({
      scope: {
        clientId: "client_a",
        brandId: "brand_a",
        siteId: "site_a",
        siteMarketId: "market_a",
      },
    });
    const present = vi.fn().mockReturnValue({ siteId: "site_a" });
    const filters = parseSeoReportFilters(new URLSearchParams({
      start: "2026-07-01",
      end: "2026-07-31",
      siteMarketId: "market_a",
    }));

    const result = await loadScopedSeoReport(access, "site_a", filters, {
      organization: { getSeoSiteContext } as never,
      reports: { getReport } as never,
      present,
    });

    expect(getSeoSiteContext).toHaveBeenCalledWith(access, "site_a", "market_a");
    expect(getReport).toHaveBeenCalledWith(access, {
      clientId: "client_a",
      brandId: "brand_a",
      siteId: "site_a",
      siteMarketId: "market_a",
      startAt: "2026-07-01T00:00:00.000Z",
      endAt: "2026-07-31T23:59:59.999Z",
    });
    expect(present).toHaveBeenCalledWith(expect.objectContaining({
      scope: expect.objectContaining({ clientId: "client_a" }),
    }), { from: "2026-07-01", to: "2026-07-31" });
    expect(result).toMatchObject({
      report: { siteId: "site_a" },
      site: { id: "site_a", name: "Site A" },
      markets: [],
    });
  });
});
