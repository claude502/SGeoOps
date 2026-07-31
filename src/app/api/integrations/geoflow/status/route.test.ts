import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAccessScope: vi.fn(),
  requireRole: vi.fn(),
  listLinks: vi.fn(),
}));

vi.mock("@/lib/authorization", () => ({
  requireAccessScope: mocks.requireAccessScope,
  requireRole: mocks.requireRole,
}));

vi.mock("@/lib/geoflow/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoflow/repository")>()),
  ScopedPrismaGeoFlowBridgeRepository: class {
    listLinks = mocks.listLinks;
  },
}));

vi.mock("@/lib/geoflow/config", () => ({
  readGeoFlowConfig: () => ({ ok: false, config: null, missing: ["GEOFLOW_API_KEY"] }),
}));

vi.mock("@/lib/geoflow/client", () => ({
  GeoFlowClient: class {},
}));

vi.mock("@/lib/prisma", () => ({
  isDatabaseConfigured: () => true,
}));

describe("GET /api/integrations/geoflow/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAccessScope.mockResolvedValue({
      actorId: "viewer_a",
      workspaceId: "workspace_internal",
      clientIds: ["client_a"],
      role: "Viewer",
    });
    mocks.listLinks.mockResolvedValue([
      {
        id: "link_a",
        contentAssetId: "asset_a",
        geoFlowTaskId: 1,
        geoFlowJobId: 2,
        geoFlowArticleId: null,
        geoFlowArticleUrl: null,
        status: "generating",
        lastSyncedAt: null,
        lastError: "authorization=Bearer legacy-secret",
        idempotencyKey: "safe-key",
        taskPayload: { authorization: "Bearer secret" },
        clientId: "client_a",
      },
    ]);
  });

  it("returns only declared public link fields to a Viewer", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/integrations/geoflow/status"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith(
      expect.objectContaining({ role: "Viewer" }),
      ["Admin", "Operator", "Reviewer", "Viewer"],
    );
    expect(body.links).toEqual([
      {
        id: "link_a",
        contentAssetId: "asset_a",
        geoFlowTaskId: 1,
        geoFlowJobId: 2,
        geoFlowArticleId: null,
        geoFlowArticleUrl: null,
        status: "generating",
        lastSyncedAt: null,
        lastError: "GEOFLOW_READ_FAILED",
        idempotencyKey: "safe-key",
      },
    ]);
  });
});
