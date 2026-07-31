import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAccessScope: vi.fn(),
  requireRole: vi.fn(),
  findContentAsset: vi.fn(),
  findContentAssetRecord: vi.fn(),
  findTrendTopic: vi.fn(),
  updateTrendTopic: vi.fn(),
  getContentPackage: vi.fn(),
  getExportAsset: vi.fn(),
  updateTrendStatus: vi.fn(),
  saveBusinessVariants: vi.fn(),
  sendToGeoFlow: vi.fn(),
  saveChannelVariants: vi.fn(),
}));

const scopeA = {
  actorId: "reviewer_a",
  workspaceId: "workspace_internal",
  role: "Reviewer" as const,
  clientIds: ["client_a"],
};

const assetA = {
  id: "asset_a",
  clientId: "client_a",
  brandId: "brand_a",
  siteId: "site_a",
  title: "Client A guide",
  summary: "Client A summary",
  body: "Client A body",
  brandEntity: "Brand A",
  canonicalUrl: "https://a.example/guides/a",
  sourceUrl: "https://a.example/guides/a",
  publishedPath: "/guides/a",
  geoScore: 80,
  seoScore: 75,
  locale: "en",
  assetType: "guide-page",
  targetKeywords: ["client a"],
  faqs: [],
  createdAt: new Date("2026-07-31T00:00:00.000Z"),
  updatedAt: new Date("2026-07-31T00:00:00.000Z"),
  status: "Ready" as const,
  owner: "Reviewer A",
  sourceSystem: "geo_ops",
  externalUrl: null,
  publishedAt: null,
  slug: "a",
  audience: null,
  seoTitle: "Client A guide",
  metaDescription: "Client A summary",
  schemaType: "article",
  ctaMode: "self_signup",
  publishTarget: "geo_ops_internal",
  isPublic: true,
  variants: [],
  trendTopic: null,
};

const assetB = {
  ...assetA,
  id: "asset_b",
  clientId: "client_b",
  brandId: "brand_b",
  siteId: "site_b",
  title: "Client B guide",
  canonicalUrl: "https://b.example/guides/b",
  sourceUrl: "https://b.example/guides/b",
};

vi.mock("@/lib/authorization", () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  requireAccessScope: mocks.requireAccessScope,
  requireRole: mocks.requireRole,
}));

vi.mock("@/lib/audit-log", () => ({
  createAuditEvent: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("@/lib/business/repository", () => ({
  PrismaBusinessRepository: class {
    findContentAsset(scope: typeof scopeA, id: string) {
      return mocks.findContentAsset(id).then((asset: typeof assetA | null) =>
        asset && scope.clientIds.includes(asset.clientId) ? asset : null,
      );
    }

    getContentPackage(scope: typeof scopeA, id: string) {
      return mocks.getContentPackage(scope, id);
    }

    getExportAsset(scope: typeof scopeA, id: string) {
      return mocks.getExportAsset(scope, id);
    }

    updateTrendStatus(
      scope: typeof scopeA,
      id: string,
      status: "approved" | "rejected",
    ) {
      return mocks.updateTrendStatus(scope, id, status);
    }

    saveChannelVariants(
      scope: typeof scopeA,
      id: string,
      variants: unknown[],
    ) {
      return mocks.saveBusinessVariants(scope, id, variants);
    }
  },
}));

vi.mock("@/lib/dashboard-snapshot", () => ({
  getRuntimeProject: vi.fn().mockResolvedValue({
    id: "site_a",
    name: "Client A",
    brand: "Brand A",
    product: "Product A",
    locale: "en",
    competitors: [],
    targetKeywords: ["client a"],
    canonicalDomain: "a.example",
  }),
}));

vi.mock("@/lib/geo-engine", () => ({
  generateChannelVariants: vi.fn(({ asset }) => [
    {
      id: `variant_${asset.id}`,
      contentAssetId: asset.id,
      platform: "LinkedIn",
      accountId: "account-a",
      copy: asset.body,
      mediaAssets: [],
      scheduledAt: null,
      status: "Draft",
    },
  ]),
}));

vi.mock("@/lib/geo-persistence", () => ({
  saveChannelVariants: mocks.saveChannelVariants,
}));

vi.mock("@/lib/geoflow/repository", () => ({
  PrismaGeoFlowBridgeRepository: class {
    findContentAsset(id: string) {
      return mocks.findContentAsset(id);
    }
  },
  ScopedPrismaGeoFlowBridgeRepository: class {},
}));

vi.mock("@/lib/geoflow/server", () => ({
  createGeoFlowBridgeService: () => ({
    sendToGeoFlow: mocks.sendToGeoFlow,
  }),
  integrationErrorResponse: () => ({
    status: 500,
    body: { error: "integration failure" },
  }),
}));

vi.mock("@/lib/geo-store", () => ({
  getAsset: vi.fn(),
  addVariants: vi.fn(),
}));

vi.mock("@/lib/postiz-handoff", () => ({
  handoffVariantsToPostiz: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  isDatabaseConfigured: vi.fn().mockReturnValue(true),
  getPrisma: vi.fn(),
  db: {
    contentAsset: {
      findUnique: mocks.findContentAssetRecord,
    },
    trendTopic: {
      findUnique: mocks.findTrendTopic,
      update: mocks.updateTrendTopic,
    },
  },
}));

describe("legacy business route client isolation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.requireAccessScope.mockResolvedValue(scopeA);
    mocks.findContentAsset.mockImplementation(async (id: string) =>
      id === assetA.id ? assetA : id === assetB.id ? assetB : null,
    );
    mocks.findContentAssetRecord.mockImplementation(async ({ where }: {
      where: { id: string };
    }) => where.id === assetA.id ? assetA : where.id === assetB.id ? assetB : null);
    mocks.findTrendTopic.mockImplementation(async ({ where }: {
      where: { id: string };
    }) => {
      if (where.id === "topic_a") {
        return {
          id: "topic_a",
          clientId: "client_a",
          brandId: "brand_a",
          siteId: "site_a",
          keyword: "Client A",
          platform: "manual",
        };
      }
      if (where.id === "topic_b") {
        return {
          id: "topic_b",
          clientId: "client_b",
          brandId: "brand_b",
          siteId: "site_b",
          keyword: "Client B",
          platform: "manual",
        };
      }
      return null;
    });
    mocks.updateTrendTopic.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      ...data,
    }));
    mocks.saveChannelVariants.mockImplementation(async (variants) => variants);
    mocks.saveBusinessVariants.mockImplementation(
      async (_scope, _id, variants) => variants,
    );
    mocks.getContentPackage.mockImplementation(
      async (scope: typeof scopeA, id: string) => {
        const asset = id === assetA.id ? assetA : id === assetB.id ? assetB : null;
        return asset && scope.clientIds.includes(asset.clientId) ? asset : null;
      },
    );
    mocks.getExportAsset.mockImplementation(
      async (scope: typeof scopeA, id: string) => {
        const asset = id === assetA.id ? assetA : id === assetB.id ? assetB : null;
        return asset && scope.clientIds.includes(asset.clientId) ? asset : null;
      },
    );
    mocks.updateTrendStatus.mockImplementation(
      async (scope: typeof scopeA, id: string, status: string) => {
        const topic = await mocks.findTrendTopic({ where: { id } });
        return topic && scope.clientIds.includes(topic.clientId)
          ? { ...topic, status }
          : null;
      },
    );
    mocks.sendToGeoFlow.mockResolvedValue({
      link: {
        id: "link_a",
        contentAssetId: assetA.id,
        geoFlowTaskId: 1,
        status: "queued",
      },
      reused: false,
    });
  });

  it("content returns the same 404 for a Client B asset and a missing asset", async () => {
    const { GET } = await import("./content/packages/[id]/route");

    for (const id of [assetB.id, "asset_missing"]) {
      const response = await GET(
        new Request(`http://localhost/api/content/packages/${id}`),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status).toBe(404);
    }

    const allowed = await GET(
      new Request(`http://localhost/api/content/packages/${assetA.id}`),
      { params: Promise.resolve({ id: assetA.id }) },
    );
    expect(allowed.status).toBe(200);
    expect(mocks.requireAccessScope).toHaveBeenCalled();
  });

  it("GEO returns the same 404 for a Client B asset and a missing asset", async () => {
    const { POST } = await import("./geo/variant/route");

    for (const contentAssetId of [assetB.id, "asset_missing"]) {
      const response = await POST(
        new Request("http://localhost/api/geo/variant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentAssetId }),
        }),
      );
      expect(response.status).toBe(404);
    }

    const allowed = await POST(
      new Request("http://localhost/api/geo/variant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentAssetId: assetA.id }),
      }),
    );
    expect(allowed.status).toBe(200);
    expect(mocks.requireAccessScope).toHaveBeenCalled();
  });

  it("trends returns the same 404 for a Client B topic and a missing topic", async () => {
    const { PATCH } = await import("./trends/[id]/status/route");

    for (const id of ["topic_b", "topic_missing"]) {
      const response = await PATCH(
        new Request(`http://localhost/api/trends/${id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "rejected" }),
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status).toBe(404);
    }

    const allowed = await PATCH(
      new Request("http://localhost/api/trends/topic_a/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "rejected" }),
      }),
      { params: Promise.resolve({ id: "topic_a" }) },
    );
    expect(allowed.status).toBe(200);
    expect(mocks.requireAccessScope).toHaveBeenCalled();
  });

  it("export packages return the same 404 for a Client B asset and a missing asset", async () => {
    const { GET } = await import("./export-packages/[id]/route");

    for (const id of ["pkg_asset_b", "pkg_asset_missing"]) {
      const response = await GET(
        new Request(`http://localhost/api/export-packages/${id}`),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status).toBe(404);
    }

    const allowed = await GET(
      new Request("http://localhost/api/export-packages/pkg_asset_a"),
      { params: Promise.resolve({ id: "pkg_asset_a" }) },
    );
    expect(allowed.status).toBe(200);
    expect(mocks.requireAccessScope).toHaveBeenCalled();
  });

  it("GEOFlow returns the same 404 for a Client B asset and a missing asset", async () => {
    const { POST } = await import("./integrations/geoflow/tasks/route");

    for (const contentAssetId of [assetB.id, "asset_missing"]) {
      const response = await POST(
        new Request("http://localhost/api/integrations/geoflow/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentAssetId }),
        }),
      );
      expect(response.status).toBe(404);
    }

    const allowed = await POST(
      new Request("http://localhost/api/integrations/geoflow/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentAssetId: assetA.id }),
      }),
    );
    expect(allowed.status).toBe(201);
    expect(mocks.requireAccessScope).toHaveBeenCalled();
  });
});
