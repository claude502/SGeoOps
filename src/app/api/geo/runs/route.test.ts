import { describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "@/types/geo";

const snapshot: DashboardSnapshot = {
  project: {
    id: "proj_test",
    name: "Wingheng GEO Workspace",
    brand: "Wingheng",
    product: "GEO Ops",
    locale: "zh-CN",
    competitors: [],
    targetKeywords: ["GEO"],
    canonicalDomain: "wingheng.technology",
  },
  providerHealth: [],
  runs: [],
  assets: [],
  variants: [],
  geoFlowLinks: [],
  auditEvents: [
    {
      id: "audit_1",
      actor: "geoops-admin",
      action: "content_asset.create",
      entityType: "ContentAsset",
      entityId: "asset_1",
      outcome: "success",
      requestId: "req_1",
      metadata: { contentAssetId: "asset_1" },
      createdAt: "2026-05-04T00:00:00.000Z",
    },
  ],
};

vi.mock("@/lib/authorization", () => ({
  requireAccessScope: vi.fn().mockResolvedValue({
    actorId: "operator_a",
    workspaceId: "workspace_internal",
    role: "Viewer",
    clientIds: ["client_a"],
  }),
  requireRole: vi.fn(),
}));

vi.mock("@/lib/business/repository", () => ({
  PrismaBusinessRepository: class {
    async listDashboardData() {
      return {
        assets: snapshot.assets,
        runs: snapshot.runs,
        variants: snapshot.variants,
        links: snapshot.geoFlowLinks,
        audits: snapshot.auditEvents,
      };
    }
  },
  recommendations: (value: unknown) => value,
}));

vi.mock("@/lib/dashboard-snapshot", () => ({
  getProjectFromEnvironment: vi.fn(() => snapshot.project),
}));

describe("GET /api/geo/runs", () => {
  it("returns scoped audit events with the dashboard snapshot", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/geo/runs"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.auditEvents).toEqual(snapshot.auditEvents);
  });
});
