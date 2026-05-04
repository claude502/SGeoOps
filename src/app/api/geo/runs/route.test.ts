import { beforeEach, describe, expect, it, vi } from "vitest";
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
      metadata: { title: "Wingheng GEO" },
      createdAt: "2026-05-04T00:00:00.000Z",
    },
  ],
};

describe("GET /api/geo/runs", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns audit events with the dashboard snapshot", async () => {
    vi.doMock("@/lib/dashboard-snapshot", () => ({
      getRuntimeDashboardSnapshot: vi.fn().mockResolvedValue(snapshot),
    }));

    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(body.auditEvents).toEqual(snapshot.auditEvents);
  });
});
