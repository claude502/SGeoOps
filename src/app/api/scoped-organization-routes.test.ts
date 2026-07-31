import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessScope } from "@/lib/authorization";

const mocks = vi.hoisted(() => ({
  requireAccessScope: vi.fn(),
  createBrand: vi.fn(),
  createSite: vi.fn(),
  createSiteMarket: vi.fn(),
  listBySite: vi.fn(),
  createIntegration: vi.fn(),
}));

vi.mock("@/lib/authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authorization")>()),
  requireAccessScope: mocks.requireAccessScope,
}));

vi.mock("@/lib/organization/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organization/repository")>()),
  organizationRepository: {
    createBrand: mocks.createBrand,
    createSite: mocks.createSite,
    createSiteMarket: mocks.createSiteMarket,
  },
}));

vi.mock("@/lib/integrations/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/repository")>()),
  integrationRepository: {
    listBySite: mocks.listBySite,
    create: mocks.createIntegration,
  },
}));

const operator: AccessScope = {
  actorId: "operator_a",
  workspaceId: "workspace_internal",
  role: "Operator",
  clientIds: ["client_a"],
};

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("scoped organization routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.requireAccessScope.mockResolvedValue(operator);
  });

  it("takes the brand client ID from the path and rejects body overrides", async () => {
    const { POST } = await import("./clients/[clientId]/brands/route");
    const overridden = await POST(
      jsonRequest("http://localhost/api/clients/client_a/brands", {
        clientId: "client_b",
        name: "Brand",
        slug: "brand",
      }),
      { params: Promise.resolve({ clientId: "client_a" }) },
    );
    expect(overridden.status).toBe(400);
    expect(mocks.createBrand).not.toHaveBeenCalled();

    mocks.createBrand.mockResolvedValue({
      id: "brand_a",
      clientId: "client_a",
      name: "Brand A",
      slug: "brand-a",
      aliases: [],
      products: null,
      industry: null,
      goals: null,
      riskCategory: "standard",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const created = await POST(
      jsonRequest("http://localhost/api/clients/client_a/brands", {
        name: " Brand A ",
        slug: "Brand-A",
      }),
      { params: Promise.resolve({ clientId: "client_a" }) },
    );

    expect(created.status).toBe(201);
    expect(mocks.createBrand).toHaveBeenCalledWith(
      operator,
      expect.objectContaining({
        clientId: "client_a",
        name: "Brand A",
        slug: "brand-a",
      }),
    );
  });

  it("takes site and market ownership IDs only from route params", async () => {
    const siteRoute = await import("./brands/[brandId]/sites/route");
    const marketRoute = await import("./sites/[siteId]/markets/route");

    const siteOverride = await siteRoute.POST(
      jsonRequest("http://localhost/api/brands/brand_a/sites", {
        brandId: "brand_b",
        name: "Site A",
        canonicalHost: "site.example.com",
        originHosts: [],
        siteType: "content",
        hostingMode: "hosted",
        canonicalRules: {},
        allowedPublishPaths: [],
      }),
      { params: Promise.resolve({ brandId: "brand_a" }) },
    );
    expect(siteOverride.status).toBe(400);

    mocks.createSiteMarket.mockResolvedValue({
      id: "market_a",
      siteId: "site_a",
      country: "MY",
      locale: "en-MY",
      defaultDevice: "desktop",
      timezone: "Asia/Kuala_Lumpur",
      settings: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const market = await marketRoute.POST(
      jsonRequest("http://localhost/api/sites/site_a/markets", {
        country: "my",
        locale: "en-my",
        timezone: "Asia/Kuala_Lumpur",
      }),
      { params: Promise.resolve({ siteId: "site_a" }) },
    );

    expect(market.status).toBe(201);
    expect(mocks.createSiteMarket).toHaveBeenCalledWith(
      operator,
      expect.objectContaining({ siteId: "site_a", country: "MY" }),
    );
  });

  it("returns the same 404 for missing and cross-client repository results", async () => {
    const { ScopedOrganizationError } = await import(
      "@/lib/organization/repository"
    );
    mocks.createSite.mockRejectedValue(
      new ScopedOrganizationError("RESOURCE_NOT_FOUND"),
    );
    const { POST } = await import("./brands/[brandId]/sites/route");

    const response = await POST(
      jsonRequest("http://localhost/api/brands/brand_b/sites", {
        name: "Site B",
        canonicalHost: "site-b.example.com",
        originHosts: [],
        siteType: "content",
        hostingMode: "hosted",
        canonicalRules: {},
        allowedPublishPaths: [],
      }),
      { params: Promise.resolve({ brandId: "brand_b" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Resource not found",
    });
  });

  it("maps a host claim collision to 409 without leaking the existing site", async () => {
    const { ScopedOrganizationError } = await import(
      "@/lib/organization/repository"
    );
    mocks.createSite.mockRejectedValue(
      new ScopedOrganizationError("HOST_CONFLICT"),
    );
    const { POST } = await import("./brands/[brandId]/sites/route");

    const response = await POST(
      jsonRequest("http://localhost/api/brands/brand_a/sites", {
        name: "Site A Two",
        canonicalHost: "claimed.example.com",
        originHosts: [],
        siteType: "content",
        hostingMode: "hosted",
        canonicalRules: {},
        allowedPublishPaths: [],
      }),
      { params: Promise.resolve({ brandId: "brand_a" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Host already claimed",
    });
  });

  it("allows Viewer to list safe integration summaries", async () => {
    mocks.requireAccessScope.mockResolvedValue({ ...operator, role: "Viewer" });
    mocks.listBySite.mockResolvedValue([
      {
        id: "integration_a",
        siteId: "site_a",
        siteMarketId: null,
        type: "wordpress",
        endpoint: "https://cms.example.com",
        capabilities: ["publish"],
        adapterVersion: "1.0.0",
        secretConfigured: true,
        healthState: "unknown",
        lastCheckedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const { GET } = await import("./sites/[siteId]/integrations/route");

    const response = await GET(
      new Request("http://localhost/api/sites/site_a/integrations"),
      { params: Promise.resolve({ siteId: "site_a" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.integrations[0]).toMatchObject({ secretConfigured: true });
    expect(JSON.stringify(body)).not.toContain("secretRef");
  });

  it("requires Admin for integration creation and uses the path site", async () => {
    const { POST } = await import("./sites/[siteId]/integrations/route");
    const body = {
      type: "wordpress",
      endpoint: "https://cms.example.com",
      capabilities: ["publish"],
      adapterVersion: "1.0.0",
      secretRef: "file:wordpress/token",
    };

    const forbidden = await POST(
      jsonRequest("http://localhost/api/sites/site_a/integrations", body),
      { params: Promise.resolve({ siteId: "site_a" }) },
    );
    expect(forbidden.status).toBe(403);

    mocks.requireAccessScope.mockResolvedValue({ ...operator, role: "Admin" });
    mocks.createIntegration.mockResolvedValue({
      id: "integration_a",
      siteId: "site_a",
      siteMarketId: null,
      type: "wordpress",
      endpoint: "https://cms.example.com",
      capabilities: ["publish"],
      adapterVersion: "1.0.0",
      secretConfigured: true,
      healthState: "unknown",
      lastCheckedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const created = await POST(
      jsonRequest("http://localhost/api/sites/site_a/integrations", body),
      { params: Promise.resolve({ siteId: "site_a" }) },
    );

    expect(created.status).toBe(201);
    expect(mocks.createIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ role: "Admin" }),
      expect.objectContaining({ siteId: "site_a" }),
    );
    expect(JSON.stringify(await created.json())).not.toContain(
      "file:wordpress/token",
    );
  });
});
