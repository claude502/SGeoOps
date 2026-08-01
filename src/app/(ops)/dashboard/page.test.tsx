import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessScope } from "@/lib/authorization";
import type { DashboardSnapshot } from "@/types/geo";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  requireAccessScope: vi.fn(),
  listDashboardData: vi.fn(),
  listUnscopedAssets: vi.fn(),
  listUnscopedLinks: vi.fn(),
  listPersistentGeoRuns: vi.fn(),
  listPersistentChannelVariants: vi.fn(),
  listRecentAuditEvents: vi.fn(),
  initialSnapshot: undefined as unknown,
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("@/lib/authorization", () => ({
  requireAccessScope: mocks.requireAccessScope,
}));

vi.mock("@/lib/prisma", () => ({
  db: {},
  isDatabaseConfigured: () => true,
}));

vi.mock("@/lib/business/repository", () => ({
  PrismaBusinessRepository: class {
    listDashboardData = mocks.listDashboardData;
  },
}));

vi.mock("@/lib/geoflow/repository", () => ({
  PrismaGeoFlowBridgeRepository: class {
    listContentAssets = mocks.listUnscopedAssets;
    listLinks = mocks.listUnscopedLinks;
  },
}));

vi.mock("@/lib/geo-persistence", () => ({
  listPersistentGeoRuns: mocks.listPersistentGeoRuns,
  listPersistentChannelVariants: mocks.listPersistentChannelVariants,
}));

vi.mock("@/lib/audit-log", () => ({
  listRecentAuditEvents: mocks.listRecentAuditEvents,
}));

vi.mock("@/components/geo-dashboard", () => ({
  GeoDashboard: ({ initialSnapshot }: { initialSnapshot: unknown }) => {
    mocks.initialSnapshot = initialSnapshot;
    return <div>dashboard</div>;
  },
}));

import TxpuroDashboardPage from "./page";

const multiClientScope: AccessScope = {
  actorId: "operator_a",
  workspaceId: "workspace_internal",
  role: "Viewer",
  clientIds: ["client_other", "client_wing_heng"],
};

const txpuroAsset = {
  id: "asset_txpuro",
  title: "Txpuro pricing",
  body: "Body",
  summary: "Summary",
  brandEntity: "Txpuro",
  sourceUrl: "https://txpuro.com/guides/pricing",
  targetKeywords: ["Txpuro pricing"],
  canonicalUrl: "https://txpuro.com/guides/pricing",
  status: "Ready",
  geoScore: 82,
  owner: "operator_a",
  sourceSystem: "geo_ops",
  externalUrl: null,
  publishedAt: null,
  updatedAt: new Date("2026-07-31T09:00:00.000Z"),
  slug: "pricing",
  locale: "zh-CN",
  assetType: "money-page",
  audience: null,
  seoTitle: null,
  metaDescription: null,
  faqs: [],
  schemaType: "product",
  ctaMode: "self_signup",
  publishTarget: "txpuro",
  isPublic: true,
  publishedPath: "/guides/pricing",
};

const otherClientAsset = {
  ...txpuroAsset,
  id: "asset_other_client",
  title: "Other client asset",
  clientId: "client_other",
};

const txpuroAudit = {
  id: "audit_txpuro",
  actor: "operator_a",
  action: "geo.audit",
  entityType: "ContentAsset",
  entityId: "asset_txpuro",
  outcome: "success",
  requestId: "request_txpuro",
  metadata: { clientId: "client_wing_heng" },
  createdAt: new Date("2026-07-31T10:00:00.000Z"),
};

describe("Txpuro dashboard page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initialSnapshot = undefined;
    mocks.headers.mockResolvedValue(new Headers());
    mocks.requireAccessScope.mockResolvedValue(multiClientScope);
    mocks.listDashboardData.mockImplementation(async (scope: AccessScope) => ({
      assets: scope.clientIds.includes("client_other")
        ? [txpuroAsset, otherClientAsset]
        : [txpuroAsset],
      runs: [],
      variants: [],
      links: [],
      audits: scope.clientIds.includes("client_other")
        ? [txpuroAudit, { ...txpuroAudit, id: "audit_other_client" }]
        : [txpuroAudit],
    }));
    mocks.listUnscopedAssets.mockResolvedValue([txpuroAsset, otherClientAsset]);
    mocks.listUnscopedLinks.mockResolvedValue([]);
    mocks.listPersistentGeoRuns.mockResolvedValue([]);
    mocks.listPersistentChannelVariants.mockResolvedValue([]);
    mocks.listRecentAuditEvents.mockResolvedValue([txpuroAudit]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("builds a Txpuro-only dashboard snapshot from a multi-client membership", async () => {
    renderToStaticMarkup(await TxpuroDashboardPage());

    expect(mocks.listDashboardData).toHaveBeenCalledWith({
      ...multiClientScope,
      clientIds: ["client_wing_heng"],
    });
    expect(mocks.listUnscopedAssets).not.toHaveBeenCalled();
    expect(mocks.listUnscopedLinks).not.toHaveBeenCalled();
    expect(mocks.listPersistentGeoRuns).not.toHaveBeenCalled();
    expect(mocks.listPersistentChannelVariants).not.toHaveBeenCalled();
    expect(mocks.listRecentAuditEvents).not.toHaveBeenCalled();

    const snapshot = mocks.initialSnapshot as DashboardSnapshot;
    expect(snapshot.assets.map((asset) => asset.id)).toEqual(["asset_txpuro"]);
    expect(snapshot.auditEvents).toEqual([
      expect.objectContaining({
        id: "audit_txpuro",
        createdAt: "2026-07-31T10:00:00.000Z",
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("other_client");
  });
});
