import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessScope } from "@/lib/authorization";
import { PrismaBusinessRepository } from "@/lib/business/repository";
import type { ChannelVariant, ContentAsset, GEORun } from "@/types/geo";

const events = vi.hoisted(() => ({
  createAuditEvent: vi.fn(),
  createOutboxEvent: vi.fn(),
}));

vi.mock("@/lib/audit-log", () => ({
  createAuditEvent: events.createAuditEvent,
}));
vi.mock("@/lib/events/outbox", () => ({
  createOutboxEvent: events.createOutboxEvent,
}));

const scope: AccessScope = {
  actorId: "operator_a",
  workspaceId: "workspace_internal",
  clientIds: ["client_a"],
  role: "Operator",
};

function geoRun(index: number): GEORun {
  return {
    id: `run_${index}`,
    projectId: "site_a",
    prompt: `Prompt ${index}`,
    provider: "ChatGPT",
    locale: "en",
    competitors: [],
    modelAnswer: "Answer",
    brandMentioned: true,
    citedDomains: ["a.example"],
    score: 80,
    recommendations: [],
    createdAt: new Date(1_700_000_000_000 + index).toISOString(),
    mode: "simulated",
  };
}

const ownership = {
  clientId: "client_a",
  brandId: "brand_a",
  siteId: "site_a",
  siteMarketId: null,
};

function generatedAsset(id = "asset_generated"):
  ContentAsset & { seoScore: number } {
  return {
    id,
    title: "Generated asset",
    body: "Body",
    summary: "Summary",
    brandEntity: "Brand A",
    sourceUrl: "https://a.example/guides/trend/topic_a",
    targetKeywords: ["keyword"],
    canonicalUrl: "https://a.example/guides/trend/topic_a",
    status: "Ready",
    geoScore: 80,
    seoScore: 75,
    updatedAt: new Date(0).toISOString(),
    owner: "geo-worker",
    sourceSystem: "trend_engine",
    locale: "zh-CN",
    assetType: "guide-page",
    schemaType: "article",
    ctaMode: "self_signup",
    publishTarget: "txpuro",
    isPublic: true,
  };
}

function selectedAsset(asset: ContentAsset & { seoScore: number }) {
  return {
    ...ownership,
    ...asset,
    sourceSystem: "trend_engine",
    externalUrl: null,
    publishedAt: null,
    slug: null,
    audience: null,
    seoTitle: null,
    metaDescription: null,
    faqs: [],
    publishedPath: null,
    updatedAt: new Date(asset.updatedAt),
  };
}

describe("PrismaBusinessRepository.saveGeoRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists 80 immutable runs with a fixed number of queries and a Site aggregate", async () => {
    const runs = Array.from({ length: 80 }, (_, index) => geoRun(index));
    const findFirst = vi.fn(async () => null);
    const create = vi.fn(async ({ data }) => data);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(runs.map(({ id }) => ({ id })));
    const createMany = vi.fn(async () => ({ count: runs.length }));
    const tx = {
      site: {
        findFirst: vi.fn(async () => ({
          id: "site_a",
          brandId: "brand_a",
          brand: {
            clientId: "client_a",
            name: "Brand A",
            client: { workspaceId: "workspace_internal" },
          },
          canonicalHost: "a.example",
          name: "Site A",
        })),
      },
      geoRun: { findFirst, create, updateMany, findMany, createMany },
    };
    const database = {
      $transaction: vi.fn(async (callback) => callback(tx)),
    };
    const repository = new PrismaBusinessRepository(database as never);

    await repository.saveGeoRuns(scope, { siteId: "site_a", runs });

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ id: "run_0", siteId: "site_a" }),
        expect.objectContaining({ id: "run_79", siteId: "site_a" }),
      ]),
      skipDuplicates: true,
    });
    expect(findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(events.createOutboxEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        aggregateType: "Site",
        aggregateId: "site_a",
        eventType: "geo.audit.completed",
      }),
    );
  });
});

describe("PrismaBusinessRepository internal content generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only resolves approved internal trends", async () => {
    const findFirst = vi.fn(async () => null);
    const repository = new PrismaBusinessRepository({
      trendTopic: { findFirst },
    } as never);

    await repository.findInternalTrend("topic_a");

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "topic_a",
          status: "approved",
          client: { workspaceId: "workspace_internal" },
        }),
      }),
    );
  });

  it("claims the generated-content business key atomically before variants and events", async () => {
    const asset = generatedAsset();
    const variant: ChannelVariant = {
      id: "variant_generated",
      contentAssetId: asset.id,
      platform: "LinkedIn",
      accountId: "account_a",
      copy: "Copy",
      mediaAssets: [],
      scheduledAt: null,
      status: "Draft",
    };
    const createAssetMany = vi.fn(async () => ({ count: 1 }));
    const findUnique = vi.fn(async () => selectedAsset(asset));
    const createVariantMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      trendTopic: {
        findFirst: vi.fn(async () => ({ id: "topic_a" })),
      },
      contentAsset: { createMany: createAssetMany, findUnique },
      channelVariant: { createMany: createVariantMany, count: vi.fn() },
    };
    const repository = new PrismaBusinessRepository({
      $transaction: vi.fn(async (callback) => callback(tx)),
    } as never);

    const result = await repository.generateContentForTrend({
      trendId: "topic_a",
      ownership,
      templateId: "template_a",
      asset,
      variants: [variant],
    });

    expect(tx.trendTopic.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "topic_a",
        status: "approved",
      }),
    });
    expect(createAssetMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [expect.objectContaining({
          clientId: "client_a",
          sourceSystem: "trend_engine",
          trendTopicId: "topic_a",
          templateId: "template_a",
        })],
      }),
    );
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clientId_sourceSystem_trendTopicId_templateId: {
            clientId: "client_a",
            sourceSystem: "trend_engine",
            trendTopicId: "topic_a",
            templateId: "template_a",
          },
        },
      }),
    );
    expect(createVariantMany).toHaveBeenCalledTimes(1);
    expect(events.createAuditEvent).toHaveBeenCalledTimes(1);
    expect(events.createOutboxEvent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ reused: false, variantCount: 1 });
  });
});
