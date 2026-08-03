import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthorizationError, type AccessScope } from "@/lib/authorization";
import { ScopedOrganizationError } from "@/lib/organization/repository";
import { SeoReportQueryInputError } from "@/lib/seo/report-queries";

const mocks = vi.hoisted(() => ({
  requireAccessScope: vi.fn(),
  loadScopedSeoReport: vi.fn(),
}));

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

const emptyReport = {
  siteId: "site_a",
  siteMarketId: null,
  range: { from: "2026-07-01", to: "2026-07-31" },
  baseline: null,
  latest: null,
  anchorPolicy: "eligible-source-runs-by-finished-at",
  formulaVersion: "seo-v1",
  metrics: [],
  coverage: [
    { source: "siteone", status: "missing", lastRunAt: null },
    { source: "unlighthouse", status: "missing", lastRunAt: null },
    { source: "search-console", status: "missing", lastRunAt: null },
    { source: "matomo", status: "missing", lastRunAt: null },
  ],
  runs: [],
  opportunities: [],
  isEmpty: true,
};

describe("GET /api/sites/[siteId]/reports/seo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAccessScope.mockResolvedValue(access);
    mocks.loadScopedSeoReport.mockResolvedValue({
      report: emptyReport,
      site: { id: "site_a", name: "Site A" },
      markets: [],
    });
  });

  it("returns the scoped empty contract without accepting ownership IDs", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/sites/site_a/reports/seo?start=2026-07-01&end=2026-07-31"),
      { params: Promise.resolve({ siteId: "site_a" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(emptyReport);
    expect(mocks.loadScopedSeoReport).toHaveBeenCalledWith(
      access,
      "site_a",
      expect.objectContaining({
        from: "2026-07-01",
        to: "2026-07-31",
        siteMarketId: null,
      }),
    );
  });

  it("returns the same safe 404 for Client B's site and an inconsistent market", async () => {
    const { GET } = await import("./route");
    mocks.loadScopedSeoReport.mockRejectedValue(
      new ScopedOrganizationError("RESOURCE_NOT_FOUND"),
    );

    for (const url of [
      "http://localhost/api/sites/site_client_b/reports/seo?start=2026-07-01&end=2026-07-31",
      "http://localhost/api/sites/site_a/reports/seo?start=2026-07-01&end=2026-07-31&siteMarketId=market_client_b",
    ]) {
      const siteId = url.includes("site_client_b") ? "site_client_b" : "site_a";
      const response = await GET(new Request(url), {
        params: Promise.resolve({ siteId }),
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Resource not found" });
    }
  });

  it.each([
    "start=2026-07-01&start=2026-07-02&end=2026-07-31",
    "start=2026-07-01&end=2026-07-31&clientId=client_b",
    "start=2026-02-30&end=2026-03-02",
    "start=2025-01-01&end=2026-07-31",
  ])("returns 400 before loading data for invalid query: %s", async (query) => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(`http://localhost/api/sites/site_a/reports/seo?${query}`),
      { params: Promise.resolve({ siteId: "site_a" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid SEO report request" });
    expect(mocks.loadScopedSeoReport).not.toHaveBeenCalled();
  });

  it("rejects malformed path IDs before loading data", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/sites/site_a/reports/seo?start=2026-07-01&end=2026-07-31"),
      { params: Promise.resolve({ siteId: " site_a " }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.loadScopedSeoReport).not.toHaveBeenCalled();
  });

  it.each([
    [new AuthorizationError("UNAUTHENTICATED"), 401],
    [new AuthorizationError("CLIENT_FORBIDDEN"), 403],
  ])("uses standard authorization status mapping", async (error, status) => {
    const { GET } = await import("./route");
    mocks.requireAccessScope.mockRejectedValue(error);

    const response = await GET(
      new Request("http://localhost/api/sites/site_a/reports/seo?start=2026-07-01&end=2026-07-31"),
      { params: Promise.resolve({ siteId: "site_a" }) },
    );

    expect(response.status).toBe(status);
    expect(mocks.loadScopedSeoReport).not.toHaveBeenCalled();
  });

  it("maps report-domain input errors to the same safe 400", async () => {
    const { GET } = await import("./route");
    mocks.loadScopedSeoReport.mockRejectedValue(new SeoReportQueryInputError());

    const response = await GET(
      new Request("http://localhost/api/sites/site_a/reports/seo?start=2026-07-01&end=2026-07-31"),
      { params: Promise.resolve({ siteId: "site_a" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid SEO report request" });
  });
});
