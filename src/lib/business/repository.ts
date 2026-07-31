import { Prisma, type PrismaClient } from "@prisma/client";

import { createAuditEvent } from "@/lib/audit-log";
import type { AccessScope } from "@/lib/authorization";
import { ScopedBusinessError } from "@/lib/business/http";
import { createOutboxEvent } from "@/lib/events/outbox";
import { scopedClientIds } from "@/lib/organization/scope";
import { db } from "@/lib/prisma";
import type {
  ChannelVariant,
  ContentAsset,
  GEORun,
  GeoRecommendation,
} from "@/types/geo";

export interface OwnedContext {
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
}

export interface OwnedContentAsset extends ContentAsset, OwnedContext {}

export interface RequiredEventContext {
  actorId: string;
  workspaceId: string;
  request?: Request;
}

type BusinessDatabase = PrismaClient;
type Transaction = Prisma.TransactionClient;

const contentAssetSelect = {
  id: true,
  clientId: true,
  brandId: true,
  siteId: true,
  siteMarketId: true,
  title: true,
  body: true,
  summary: true,
  brandEntity: true,
  sourceUrl: true,
  targetKeywords: true,
  canonicalUrl: true,
  status: true,
  geoScore: true,
  owner: true,
  sourceSystem: true,
  externalUrl: true,
  publishedAt: true,
  updatedAt: true,
  slug: true,
  locale: true,
  assetType: true,
  audience: true,
  seoTitle: true,
  metaDescription: true,
  faqs: true,
  schemaType: true,
  ctaMode: true,
  publishTarget: true,
  isPublic: true,
  publishedPath: true,
  seoScore: true,
} satisfies Prisma.ContentAssetSelect;

type ContentAssetRecord = Prisma.ContentAssetGetPayload<{
  select: typeof contentAssetSelect;
}>;

const packageSelect = {
  id: true,
  title: true,
  summary: true,
  geoScore: true,
  seoScore: true,
  locale: true,
  assetType: true,
  publishedAt: true,
  updatedAt: true,
  variants: {
    select: {
      id: true,
      platform: true,
      copy: true,
      mediaAssets: true,
      status: true,
      scheduledAt: true,
      metrics: { orderBy: { recordedAt: "desc" as const }, take: 5 },
    },
  },
  trendTopic: {
    select: { keyword: true, platform: true, score: true },
  },
} satisfies Prisma.ContentAssetSelect;

const exportSelect = {
  id: true,
  title: true,
  summary: true,
  body: true,
  canonicalUrl: true,
  sourceUrl: true,
  publishedPath: true,
  geoScore: true,
  seoScore: true,
  locale: true,
  assetType: true,
  targetKeywords: true,
  faqs: true,
  createdAt: true,
  updatedAt: true,
  variants: {
    select: {
      platform: true,
      copy: true,
      mediaAssets: true,
      metrics: { orderBy: { recordedAt: "desc" as const }, take: 5 },
    },
  },
  trendTopic: true,
} satisfies Prisma.ContentAssetSelect;

const ownershipSelect = {
  id: true,
  brandId: true,
  brand: {
    select: {
      clientId: true,
      name: true,
      client: {
        select: {
          workspaceId: true,
        },
      },
    },
  },
  canonicalHost: true,
  name: true,
} satisfies Prisma.SiteSelect;

function toIso(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function mapContentAsset(asset: ContentAssetRecord): OwnedContentAsset {
  return {
    id: asset.id,
    clientId: asset.clientId,
    brandId: asset.brandId,
    siteId: asset.siteId,
    siteMarketId: asset.siteMarketId,
    title: asset.title,
    body: asset.body,
    summary: asset.summary,
    brandEntity: asset.brandEntity,
    sourceUrl: asset.sourceUrl,
    targetKeywords: asset.targetKeywords,
    canonicalUrl: asset.canonicalUrl,
    status: asset.status,
    geoScore: asset.geoScore,
    owner: asset.owner,
    sourceSystem: asset.sourceSystem,
    externalUrl: asset.externalUrl,
    publishedAt: toIso(asset.publishedAt),
    updatedAt: toIso(asset.updatedAt) ?? new Date().toISOString(),
    slug: asset.slug ?? undefined,
    locale: asset.locale as ContentAsset["locale"],
    assetType: asset.assetType as ContentAsset["assetType"],
    audience: asset.audience,
    seoTitle: asset.seoTitle,
    metaDescription: asset.metaDescription,
    faqs: Array.isArray(asset.faqs)
      ? (asset.faqs as ContentAsset["faqs"])
      : [],
    schemaType: asset.schemaType as ContentAsset["schemaType"],
    ctaMode: asset.ctaMode as ContentAsset["ctaMode"],
    publishTarget: asset.publishTarget as ContentAsset["publishTarget"],
    isPublic: asset.isPublic,
    publishedPath: asset.publishedPath,
  };
}

function toDate(value: string | Date | null | undefined) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function requireRecord<T>(record: T | null): T {
  if (!record) {
    throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
  }
  return record;
}

export function legacyScopeWhere(scope: AccessScope) {
  return {
    clientId: { in: scopedClientIds(scope) },
    client: { workspaceId: scope.workspaceId },
  };
}

function eventContext(
  scope: AccessScope,
  request?: Request,
): RequiredEventContext {
  return {
    actorId: scope.actorId,
    workspaceId: scope.workspaceId,
    request,
  };
}

async function writeRequiredEvents(
  tx: Transaction,
  ownership: OwnedContext,
  context: RequiredEventContext,
  audit: {
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  },
  outbox: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
) {
  await createAuditEvent(tx, {
    ...context,
    ...ownership,
    action: audit.action,
    entityType: audit.entityType,
    entityId: audit.entityId,
    outcome: "success",
    metadata: audit.metadata,
  });
  await createOutboxEvent(tx, outbox);
}

export class PrismaBusinessRepository {
  constructor(private readonly database: BusinessDatabase = db) {}

  private async requireSite(
    transaction: Transaction | BusinessDatabase,
    scope: AccessScope,
    siteId: string,
  ) {
    const site = await transaction.site.findFirst({
      where: {
        id: siteId,
        brand: {
          client: {
            workspaceId: scope.workspaceId,
            id: { in: scopedClientIds(scope) },
          },
        },
      },
      select: ownershipSelect,
    });
    return requireRecord(site);
  }

  async getSiteContext(
    scope: AccessScope,
    siteId: string,
  ): Promise<
    OwnedContext & {
      siteName: string;
      brandName: string;
      canonicalHost: string;
    }
  > {
    const site = await this.requireSite(this.database, scope, siteId);
    return {
      clientId: site.brand.clientId,
      brandId: site.brandId,
      siteId: site.id,
      siteMarketId: null,
      siteName: site.name,
      brandName: site.brand.name,
      canonicalHost: site.canonicalHost,
    };
  }

  async findContentAsset(
    scope: AccessScope,
    contentAssetId: string,
  ): Promise<OwnedContentAsset | null> {
    const asset = await this.database.contentAsset.findFirst({
      where: {
        id: contentAssetId,
        ...legacyScopeWhere(scope),
      },
      select: contentAssetSelect,
    });
    return asset ? mapContentAsset(asset) : null;
  }

  async getContentPackage(scope: AccessScope, contentAssetId: string) {
    return this.database.contentAsset.findFirst({
      where: {
        id: contentAssetId,
        ...legacyScopeWhere(scope),
      },
      select: packageSelect,
    });
  }

  async listContentPackages(
    scope: AccessScope,
    options: { platform?: string; cursor?: string; limit: number },
  ) {
    if (options.cursor) {
      requireRecord(
        await this.database.contentAsset.findFirst({
          where: {
            id: options.cursor,
            ...legacyScopeWhere(scope),
          },
          select: { id: true },
        }),
      );
    }

    return this.database.contentAsset.findMany({
      where: {
        ...legacyScopeWhere(scope),
        isPublic: true,
        status: "Ready",
        ...(options.platform
          ? { variants: { some: { platform: options.platform } } }
          : {}),
      },
      select: {
        ...packageSelect,
        variants: {
          ...packageSelect.variants,
          where: options.platform
            ? { platform: options.platform }
            : undefined,
        },
      },
      orderBy: { updatedAt: "desc" },
      take: options.limit + 1,
      ...(options.cursor
        ? { cursor: { id: options.cursor }, skip: 1 }
        : {}),
    });
  }

  async getExportAsset(scope: AccessScope, contentAssetId: string) {
    return this.database.contentAsset.findFirst({
      where: {
        id: contentAssetId,
        ...legacyScopeWhere(scope),
      },
      select: exportSelect,
    });
  }

  async listExportAssets(
    scope: AccessScope,
    options: {
      platform?: string;
      language?: string;
      cursor?: string;
      limit: number;
    },
  ) {
    if (options.cursor) {
      requireRecord(
        await this.database.contentAsset.findFirst({
          where: {
            id: options.cursor,
            ...legacyScopeWhere(scope),
          },
          select: { id: true },
        }),
      );
    }

    return this.database.contentAsset.findMany({
      where: {
        ...legacyScopeWhere(scope),
        isPublic: true,
        status: "Ready",
        ...(options.language ? { locale: options.language } : {}),
        ...(options.platform
          ? { variants: { some: { platform: options.platform } } }
          : {}),
      },
      select: {
        ...exportSelect,
        variants: {
          ...exportSelect.variants,
          where: options.platform
            ? { platform: options.platform }
            : undefined,
        },
      },
      orderBy: { updatedAt: "desc" },
      take: options.limit + 1,
      ...(options.cursor
        ? { cursor: { id: options.cursor }, skip: 1 }
        : {}),
    });
  }

  async createContentAsset(
    scope: AccessScope,
    siteId: string,
    asset: ContentAsset,
    request?: Request,
  ): Promise<OwnedContentAsset> {
    return this.database.$transaction(async (tx) => {
      const site = await this.requireSite(tx, scope, siteId);
      const ownership: OwnedContext = {
        clientId: site.brand.clientId,
        brandId: site.brandId,
        siteId: site.id,
        siteMarketId: null,
      };
      const created = await tx.contentAsset.create({
        data: {
          ...ownership,
          id: asset.id,
          title: asset.title,
          body: asset.body,
          summary: asset.summary,
          brandEntity: asset.brandEntity,
          sourceUrl: asset.sourceUrl,
          targetKeywords: asset.targetKeywords,
          canonicalUrl: asset.canonicalUrl,
          status: asset.status,
          geoScore: asset.geoScore,
          owner: asset.owner,
          sourceSystem: asset.sourceSystem,
          externalUrl: asset.externalUrl,
          publishedAt: toDate(asset.publishedAt),
          slug: asset.slug ?? null,
          locale: asset.locale,
          assetType: asset.assetType,
          audience: asset.audience,
          seoTitle: asset.seoTitle,
          metaDescription: asset.metaDescription,
          faqs: json(asset.faqs),
          schemaType: asset.schemaType,
          ctaMode: asset.ctaMode,
          publishTarget: asset.publishTarget,
          isPublic: asset.isPublic,
          publishedPath: asset.publishedPath,
        },
        select: contentAssetSelect,
      });
      await writeRequiredEvents(
        tx,
        ownership,
        eventContext(scope, request),
        {
          action: "content_asset.create",
          entityType: "ContentAsset",
          entityId: created.id,
          metadata: {
            contentAssetId: created.id,
            keywordCount: created.targetKeywords.length,
          },
        },
        {
          aggregateType: "ContentAsset",
          aggregateId: created.id,
          eventType: "content_asset.created",
          payload: {
            contentAssetId: created.id,
            siteId: created.siteId,
          },
        },
      );
      return mapContentAsset(created);
    });
  }

  async createVariantMetric(
    scope: AccessScope,
    variantId: string,
    input: {
      impressions: number;
      clicks: number;
      shares: number;
      recordedAt?: string;
    },
    request?: Request,
  ) {
    return this.database.$transaction(async (tx) => {
      const variant = requireRecord(
        await tx.channelVariant.findFirst({
          where: {
            id: variantId,
            ...legacyScopeWhere(scope),
          },
          select: {
            id: true,
            clientId: true,
            brandId: true,
            siteId: true,
            siteMarketId: true,
          },
        }),
      );
      const ownership: OwnedContext = {
        clientId: variant.clientId,
        brandId: variant.brandId,
        siteId: variant.siteId,
        siteMarketId: variant.siteMarketId,
      };
      const metric = await tx.variantMetric.create({
        data: {
          ...ownership,
          channelVariantId: variant.id,
          impressions: input.impressions,
          clicks: input.clicks,
          shares: input.shares,
          recordedAt: input.recordedAt
            ? new Date(input.recordedAt)
            : new Date(),
        },
      });
      await writeRequiredEvents(
        tx,
        ownership,
        eventContext(scope, request),
        {
          action: "variant_metric.create",
          entityType: "VariantMetric",
          entityId: metric.id,
          metadata: {
            variantMetricId: metric.id,
            channelVariantId: variant.id,
          },
        },
        {
          aggregateType: "ChannelVariant",
          aggregateId: variant.id,
          eventType: "variant_metric.created",
          payload: {
            variantMetricId: metric.id,
            channelVariantId: variant.id,
          },
        },
      );
      return metric;
    });
  }

  async saveChannelVariants(
    scope: AccessScope,
    contentAssetId: string,
    variants: ChannelVariant[],
    request?: Request,
  ): Promise<ChannelVariant[]> {
    return this.database.$transaction(async (tx) => {
      const asset = requireRecord(
        await tx.contentAsset.findFirst({
          where: {
            id: contentAssetId,
            ...legacyScopeWhere(scope),
          },
          select: {
            id: true,
            clientId: true,
            brandId: true,
            siteId: true,
            siteMarketId: true,
          },
        }),
      );
      const ownership: OwnedContext = {
        clientId: asset.clientId,
        brandId: asset.brandId,
        siteId: asset.siteId,
        siteMarketId: asset.siteMarketId,
      };

      for (const variant of variants) {
        const existing = await tx.channelVariant.findFirst({
          where: {
            id: variant.id,
            ...legacyScopeWhere(scope),
          },
          select: { id: true },
        });
        const data = {
          platform: variant.platform,
          accountId: variant.accountId,
          copy: variant.copy,
          mediaAssets: variant.mediaAssets,
          scheduledAt: toDate(variant.scheduledAt),
          status: variant.status,
        };
        if (existing) {
          const updated = await tx.channelVariant.updateMany({
            where: {
              id: variant.id,
              ...legacyScopeWhere(scope),
            },
            data,
          });
          if (updated.count !== 1) {
            throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
          }
        } else {
          await tx.channelVariant.create({
            data: {
              ...ownership,
              ...data,
              id: variant.id,
              contentAssetId: asset.id,
            },
          });
        }
      }

      await writeRequiredEvents(
        tx,
        ownership,
        eventContext(scope, request),
        {
          action: "geo.variant",
          entityType: "ContentAsset",
          entityId: asset.id,
          metadata: {
            contentAssetId: asset.id,
            variantCount: variants.length,
          },
        },
        {
          aggregateType: "ContentAsset",
          aggregateId: asset.id,
          eventType: "channel_variants.generated",
          payload: {
            contentAssetId: asset.id,
            variantIds: variants.map((variant) => variant.id),
          },
        },
      );
      return variants;
    });
  }

  async saveGeoRuns(
    scope: AccessScope,
    input: {
      siteId?: string;
      contentAssetId?: string;
      runs: GEORun[];
    },
    request?: Request,
  ): Promise<GEORun[]> {
    return this.database.$transaction(async (tx) => {
      let ownership: OwnedContext;
      if (input.contentAssetId) {
        const asset = requireRecord(
          await tx.contentAsset.findFirst({
            where: {
              id: input.contentAssetId,
              ...legacyScopeWhere(scope),
            },
            select: {
              id: true,
              clientId: true,
              brandId: true,
              siteId: true,
              siteMarketId: true,
            },
          }),
        );
        ownership = asset;
      } else {
        const site = await this.requireSite(
          tx,
          scope,
          input.siteId ?? "",
        );
        ownership = {
          clientId: site.brand.clientId,
          brandId: site.brandId,
          siteId: site.id,
          siteMarketId: null,
        };
      }

      for (const run of input.runs) {
        const data = {
          projectId: run.projectId,
          contentAssetId: input.contentAssetId ?? null,
          prompt: run.prompt,
          provider: run.provider,
          locale: run.locale,
          competitors: run.competitors,
          modelAnswer: run.modelAnswer,
          brandMentioned: run.brandMentioned,
          citedDomains: run.citedDomains,
          score: run.score,
          recommendations: json(run.recommendations),
          createdAt: new Date(run.createdAt),
          mode: run.mode,
        };
        const existing = await tx.geoRun.findFirst({
          where: { id: run.id, ...legacyScopeWhere(scope) },
          select: { id: true },
        });
        if (existing) {
          const updated = await tx.geoRun.updateMany({
            where: { id: run.id, ...legacyScopeWhere(scope) },
            data,
          });
          if (updated.count !== 1) {
            throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
          }
        } else {
          await tx.geoRun.create({
            data: { ...ownership, ...data, id: run.id },
          });
        }
      }

      if (input.contentAssetId) {
        const aggregate = await tx.geoRun.aggregate({
          _avg: { score: true },
          where: {
            contentAssetId: input.contentAssetId,
            ...legacyScopeWhere(scope),
          },
        });
        const updated = await tx.contentAsset.updateMany({
          where: {
            id: input.contentAssetId,
            ...legacyScopeWhere(scope),
          },
          data: { geoScore: Math.round(aggregate._avg.score ?? 0) },
        });
        if (updated.count !== 1) {
          throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
        }
      }

      const aggregateId =
        input.contentAssetId ?? input.runs[0]?.id ?? ownership.siteId;
      await writeRequiredEvents(
        tx,
        ownership,
        eventContext(scope, request),
        {
          action: "geo.audit",
          entityType: input.contentAssetId ? "ContentAsset" : "GeoRun",
          entityId: aggregateId,
          metadata: {
            contentAssetId: input.contentAssetId ?? null,
            runCount: input.runs.length,
          },
        },
        {
          aggregateType: input.contentAssetId ? "ContentAsset" : "Site",
          aggregateId,
          eventType: "geo.audit.completed",
          payload: {
            contentAssetId: input.contentAssetId ?? null,
            siteId: ownership.siteId,
            geoRunIds: input.runs.map((run) => run.id),
          },
        },
      );
      return input.runs.map((run) => ({
        ...run,
        contentAssetId: input.contentAssetId ?? null,
      }));
    });
  }

  async recordBriefGenerated(
    scope: AccessScope,
    siteId: string,
    metadata: { projectId: string; keywordCount: number; competitorCount: number },
    request?: Request,
  ) {
    return this.database.$transaction(async (tx) => {
      const site = await this.requireSite(tx, scope, siteId);
      const ownership: OwnedContext = {
        clientId: site.brand.clientId,
        brandId: site.brandId,
        siteId: site.id,
        siteMarketId: null,
      };
      await writeRequiredEvents(
        tx,
        ownership,
        eventContext(scope, request),
        {
          action: "geo.brief",
          entityType: "Site",
          entityId: site.id,
          metadata,
        },
        {
          aggregateType: "Site",
          aggregateId: site.id,
          eventType: "geo.brief.generated",
          payload: { siteId: site.id },
        },
      );
    });
  }

  async createTrendTopic(
    scope: AccessScope,
    siteId: string,
    input: {
      keyword: string;
      platform: string;
      score: number;
      region: string;
      expiresAt?: string;
    },
    request?: Request,
  ) {
    return this.database.$transaction(async (tx) => {
      const site = await this.requireSite(tx, scope, siteId);
      const ownership: OwnedContext = {
        clientId: site.brand.clientId,
        brandId: site.brandId,
        siteId: site.id,
        siteMarketId: null,
      };
      const topic = await tx.trendTopic.create({
        data: {
          ...ownership,
          keyword: input.keyword,
          platform: input.platform,
          score: input.score,
          region: input.region,
          sourceType: "manual",
          capturedAt: new Date(),
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        },
      });
      await writeRequiredEvents(
        tx,
        ownership,
        eventContext(scope, request),
        {
          action: "trend_topic.create",
          entityType: "TrendTopic",
          entityId: topic.id,
          metadata: { trendTopicId: topic.id },
        },
        {
          aggregateType: "TrendTopic",
          aggregateId: topic.id,
          eventType: "trend_topic.created",
          payload: { trendTopicId: topic.id, siteId: topic.siteId },
        },
      );
      return topic;
    });
  }

  async updateTrendStatus(
    scope: AccessScope,
    topicId: string,
    status: "approved" | "rejected",
    request?: Request,
  ) {
    return this.database.$transaction(async (tx) => {
      const topic = requireRecord(
        await tx.trendTopic.findFirst({
          where: { id: topicId, ...legacyScopeWhere(scope) },
        }),
      );
      const updated = await tx.trendTopic.updateMany({
        where: { id: topicId, ...legacyScopeWhere(scope) },
        data: { status },
      });
      if (updated.count !== 1) {
        throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      }
      const ownership: OwnedContext = {
        clientId: topic.clientId,
        brandId: topic.brandId,
        siteId: topic.siteId,
        siteMarketId: topic.siteMarketId,
      };
      await writeRequiredEvents(
        tx,
        ownership,
        eventContext(scope, request),
        {
          action: "trend_topic.status.update",
          entityType: "TrendTopic",
          entityId: topic.id,
          metadata: { trendTopicId: topic.id, status },
        },
        {
          aggregateType: "TrendTopic",
          aggregateId: topic.id,
          eventType:
            status === "approved"
              ? "trend.approved"
              : "trend.rejected",
          payload: {
            topicId: topic.id,
            siteId: topic.siteId,
          },
        },
      );
      return { ...topic, status };
    });
  }

  async listDashboardData(scope: AccessScope) {
    const where = legacyScopeWhere(scope);
    const [assets, runs, variants, links, audits] = await Promise.all([
      this.database.contentAsset.findMany({
        where,
        select: contentAssetSelect,
        orderBy: { updatedAt: "desc" },
        take: 100,
      }),
      this.database.geoRun.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      this.database.channelVariant.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: 100,
      }),
      this.database.geoFlowTaskLink.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: 100,
      }),
      this.database.auditEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);
    return {
      assets: assets.map(mapContentAsset),
      runs,
      variants,
      links,
      audits,
    };
  }

  async findInternalTrend(topicId: string) {
    return this.database.trendTopic.findFirst({
      where: {
        id: topicId,
        client: { workspaceId: "workspace_internal" },
      },
      include: {
        site: {
          include: {
            brand: {
              include: {
                client: true,
              },
            },
          },
        },
      },
    });
  }

  async generateContentForTrend(input: {
    trendId: string;
    ownership: OwnedContext;
    templateId: string;
    asset: ContentAsset & { seoScore: number };
    variants: ChannelVariant[];
    request?: Request;
  }) {
    return this.database.$transaction(async (tx) => {
      const trend = requireRecord(
        await tx.trendTopic.findFirst({
          where: {
            id: input.trendId,
            ...input.ownership,
            client: { workspaceId: "workspace_internal" },
          },
        }),
      );
      const existing = await tx.contentAsset.findFirst({
        where: {
          trendTopicId: trend.id,
          sourceSystem: "trend_engine",
          templateId: input.templateId,
          ...input.ownership,
          client: { workspaceId: "workspace_internal" },
        },
        select: contentAssetSelect,
      });

      if (existing) {
        const variantCount = await tx.channelVariant.count({
          where: {
            contentAssetId: existing.id,
            ...input.ownership,
            client: { workspaceId: "workspace_internal" },
          },
        });
        return {
          asset: mapContentAsset(existing),
          variantCount,
          reused: true,
          seoScore: existing.seoScore ?? 0,
        };
      }

      const created = await tx.contentAsset.create({
        data: {
          ...input.ownership,
          id: input.asset.id,
          title: input.asset.title,
          body: input.asset.body,
          summary: input.asset.summary,
          brandEntity: input.asset.brandEntity,
          sourceUrl: input.asset.sourceUrl,
          targetKeywords: input.asset.targetKeywords,
          canonicalUrl: input.asset.canonicalUrl,
          status: input.asset.status,
          geoScore: input.asset.geoScore,
          seoScore: input.asset.seoScore,
          owner: input.asset.owner,
          sourceSystem: "trend_engine",
          slug: input.asset.slug ?? null,
          locale: input.asset.locale,
          assetType: input.asset.assetType,
          seoTitle: input.asset.seoTitle,
          metaDescription: input.asset.metaDescription,
          faqs: json(input.asset.faqs),
          schemaType: input.asset.schemaType,
          ctaMode: input.asset.ctaMode,
          publishTarget: input.asset.publishTarget,
          isPublic: input.asset.isPublic,
          publishedPath: input.asset.publishedPath,
          trendTopicId: trend.id,
          templateId: input.templateId,
        },
        select: contentAssetSelect,
      });

      for (const variant of input.variants) {
        await tx.channelVariant.create({
          data: {
            ...input.ownership,
            id: variant.id,
            contentAssetId: created.id,
            platform: variant.platform,
            accountId: variant.accountId,
            copy: variant.copy,
            mediaAssets: variant.mediaAssets,
            scheduledAt: toDate(variant.scheduledAt),
            status: variant.status,
          },
        });
      }

      await writeRequiredEvents(
        tx,
        input.ownership,
        {
          actorId: "service:geo-worker",
          workspaceId: "workspace_internal",
          request: input.request,
        },
        {
          action: "content.generate",
          entityType: "ContentAsset",
          entityId: created.id,
          metadata: {
            contentAssetId: created.id,
            trendTopicId: trend.id,
            variantCount: input.variants.length,
          },
        },
        {
          aggregateType: "ContentAsset",
          aggregateId: created.id,
          eventType: "content.generated",
          payload: {
            contentAssetId: created.id,
            trendTopicId: trend.id,
            siteId: created.siteId,
          },
        },
      );

      return {
        asset: mapContentAsset(created),
        variantCount: input.variants.length,
        reused: false,
        seoScore: input.asset.seoScore,
      };
    });
  }

  async seedOwnedContentAssets(
    scope: AccessScope,
    siteId: string,
    assets: ContentAsset[],
    request?: Request,
  ) {
    return this.database.$transaction(async (tx) => {
      const site = await this.requireSite(tx, scope, siteId);
      const ownership: OwnedContext = {
        clientId: site.brand.clientId,
        brandId: site.brandId,
        siteId: site.id,
        siteMarketId: null,
      };
      for (const asset of assets) {
        const existing = await tx.contentAsset.findFirst({
          where: { id: asset.id, ...legacyScopeWhere(scope) },
          select: { id: true },
        });
        const data = {
          title: asset.title,
          body: asset.body,
          summary: asset.summary,
          brandEntity: asset.brandEntity,
          sourceUrl: asset.sourceUrl,
          targetKeywords: asset.targetKeywords,
          canonicalUrl: asset.canonicalUrl,
          status: asset.status,
          geoScore: asset.geoScore,
          owner: asset.owner,
          sourceSystem: asset.sourceSystem,
          externalUrl: asset.externalUrl,
          publishedAt: toDate(asset.publishedAt),
          slug: asset.slug ?? null,
          locale: asset.locale,
          assetType: asset.assetType,
          audience: asset.audience,
          seoTitle: asset.seoTitle,
          metaDescription: asset.metaDescription,
          faqs: json(asset.faqs),
          schemaType: asset.schemaType,
          ctaMode: asset.ctaMode,
          publishTarget: asset.publishTarget,
          isPublic: asset.isPublic,
          publishedPath: asset.publishedPath,
        };
        if (existing) {
          const updated = await tx.contentAsset.updateMany({
            where: { id: asset.id, ...legacyScopeWhere(scope) },
            data,
          });
          if (updated.count !== 1) {
            throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
          }
        } else {
          await tx.contentAsset.create({
            data: { ...ownership, ...data, id: asset.id },
          });
        }
      }
      await writeRequiredEvents(
        tx,
        ownership,
        eventContext(scope, request),
        {
          action: "workspace.txpuro.init",
          entityType: "Site",
          entityId: site.id,
          metadata: { siteId: site.id, assetCount: assets.length },
        },
        {
          aggregateType: "Site",
          aggregateId: site.id,
          eventType: "txpuro.workspace.initialized",
          payload: {
            siteId: site.id,
            contentAssetIds: assets.map((asset) => asset.id),
          },
        },
      );
      return assets;
    });
  }
}

export function recommendations(value: unknown): GeoRecommendation[] {
  return Array.isArray(value) ? (value as GeoRecommendation[]) : [];
}
