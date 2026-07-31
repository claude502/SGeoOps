import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAccessScope: vi.fn(),
  requireRole: vi.fn(),
  getSiteContext: vi.fn(),
  sync: vi.fn(),
}));

vi.mock("@/lib/authorization", () => ({
  requireAccessScope: mocks.requireAccessScope,
  requireRole: mocks.requireRole,
}));

vi.mock("@/lib/business/repository", () => ({
  PrismaBusinessRepository: class {
    getSiteContext = mocks.getSiteContext;
  },
}));

vi.mock("@/lib/geoflow/repository", () => ({
  ScopedPrismaGeoFlowBridgeRepository: class {},
}));

vi.mock("@/lib/geoflow/server", () => ({
  createGeoFlowBridgeService: () => ({ sync: mocks.sync }),
  integrationErrorResponse: () => ({ status: 500, body: {} }),
}));

describe("POST /api/integrations/geoflow/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAccessScope.mockResolvedValue({
      actorId: "operator_a",
      workspaceId: "workspace_internal",
      clientIds: ["client_a"],
      role: "Operator",
    });
    mocks.getSiteContext.mockResolvedValue({
      clientId: "client_a",
      brandId: "brand_a",
      siteId: "site_a",
      siteMarketId: null,
    });
    mocks.sync.mockResolvedValue({
      syncRunId: "sync_a",
      successCount: 0,
      failureCount: 0,
      links: [],
      errors: [],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("passes a bounded cursor page to the bridge", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/integrations/geoflow/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: "site_a", cursor: "link_25", limit: 10 }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledWith({ cursor: "link_25", limit: 10 });
  });

  it("rejects pages larger than the repository maximum", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/integrations/geoflow/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: "site_a", limit: 26 }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
