import type { Prisma, PrismaClient } from "@prisma/client";
import { createAuditEvent } from "@/lib/audit-log";
import type { AccessScope } from "@/lib/authorization";
import type { OwnedContext } from "@/lib/business/repository";
import { legacyScopeWhere, PrismaBusinessRepository } from "@/lib/business/repository";
import { ScopedBusinessError } from "@/lib/business/http";
import { createOutboxEvent } from "@/lib/events/outbox";
import {
  publicGeoFlowLinkSelect,
  stableGeoFlowErrorCode,
  toPublicGeoFlowLink,
  type PublicGeoFlowLinkInput,
} from "@/lib/geoflow/public-link";
import type { ContentAsset, GeoFlowTaskLinkView, GeoFlowTaskStatus } from "@/types/geo";
import { db, getPrisma, isDatabaseConfigured } from "@/lib/prisma";

export interface GeoFlowTaskLinkRecord extends GeoFlowTaskLinkView {
  taskPayload: unknown;
}

export interface CreateGeoFlowTaskLinkInput {
  contentAssetId: string;
  idempotencyKey: string;
  status: GeoFlowTaskStatus;
  taskPayload: unknown;
}

export interface UpdateGeoFlowTaskLinkInput {
  geoFlowTaskId?: number | null;
  geoFlowJobId?: number | null;
  geoFlowArticleId?: number | null;
  geoFlowArticleUrl?: string | null;
  status?: GeoFlowTaskStatus;
  lastSyncedAt?: string | Date | null;
  lastError?: string | null;
}

export interface PublishGeoFlowTaskLinkInput {
  geoFlowJobId: number | null;
  geoFlowArticleId: number;
  geoFlowArticleUrl: string;
  publishedAt: string | Date;
}

export interface ListSyncableLinksOptions {
  cursor?: string;
  limit?: number;
}

export interface SyncableGeoFlowLinkPage {
  links: GeoFlowTaskLinkRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ListContentAssetsOptions {
  take?: number;
  cursor?: string;
}

export interface GeoFlowBridgeRepository {
  ensureContentAsset(asset: ContentAsset): Promise<void>;
  findContentAsset(contentAssetId: string): Promise<ContentAsset | null>;
  findPublicContentAsset(
    siteId: string,
    slug: string,
    locale: string,
    publishTarget?: string,
  ): Promise<ContentAsset | null>;
  listPublicContentAssets(
    siteId: string,
    publishTarget?: string,
  ): Promise<ContentAsset[]>;
  listContentAssets(options?: ListContentAssetsOptions): Promise<ContentAsset[]>;
  seedContentAssets(assets: ContentAsset[]): Promise<void>;
  findLinkByIdempotencyKey(idempotencyKey: string): Promise<GeoFlowTaskLinkRecord | null>;
  createLink(input: CreateGeoFlowTaskLinkInput): Promise<GeoFlowTaskLinkRecord>;
  updateLink(id: string, input: UpdateGeoFlowTaskLinkInput): Promise<GeoFlowTaskLinkRecord>;
  listSyncableLinks(options?: ListSyncableLinksOptions): Promise<SyncableGeoFlowLinkPage>;
  listLinks(): Promise<GeoFlowTaskLinkView[]>;
  commitPublishedLink(
    id: string,
    input: PublishGeoFlowTaskLinkInput,
  ): Promise<GeoFlowTaskLinkRecord>;
  createSyncRun(): Promise<{ id: string }>;
  finishSyncRun(
    id: string,
    result: { successCount: number; failureCount: number; errorSummary?: string | null },
  ): Promise<void>;
}

function toDate(value: string | Date | null | undefined) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

function toIso(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}

const privateLinkSelect = {
  ...publicGeoFlowLinkSelect,
  clientId: true,
  brandId: true,
  siteId: true,
  siteMarketId: true,
  taskPayload: true,
} satisfies Prisma.GeoFlowTaskLinkSelect;

function mapPrivateLink(
  link: PublicGeoFlowLinkInput & { taskPayload: unknown },
): GeoFlowTaskLinkRecord {
  return {
    ...toPublicGeoFlowLink(link),
    taskPayload: link.taskPayload ?? null,
  };
}

export { publicGeoFlowLinkSelect, stableGeoFlowErrorCode, toPublicGeoFlowLink };

function syncPageLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return 25;
  return Math.min(25, Math.max(1, Math.trunc(value ?? 25)));
}

function pageLinks(links: GeoFlowTaskLinkRecord[], limit: number) {
  const hasMore = links.length > limit;
  const page = links.slice(0, limit);
  return {
    links: page,
    hasMore,
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}

function mapContentStatus(status: ContentAsset["status"]) {
  return status;
}

function normalizeOwnership(ownership: OwnedContext): OwnedContext {
  return {
    clientId: ownership.clientId,
    brandId: ownership.brandId,
    siteId: ownership.siteId,
    siteMarketId: ownership.siteMarketId,
  };
}

function mapAsset(asset: {
  id: string;
  title: string;
  body: string;
  summary: string;
  brandEntity: string;
  sourceUrl: string;
  targetKeywords: string[];
  canonicalUrl: string;
  status: ContentAsset["status"];
  geoScore: number;
  owner: string;
  sourceSystem: string;
  externalUrl: string | null;
  publishedAt: Date | string | null;
  updatedAt: Date | string;
  slug: string | null;
  locale: string;
  assetType: string;
  audience: string | null;
  seoTitle: string | null;
  metaDescription: string | null;
  faqs: unknown;
  schemaType: string;
  ctaMode: string;
  publishTarget: string;
  isPublic: boolean;
  publishedPath: string | null;
}): ContentAsset {
  return {
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
    publishedAt: toIso(asset.publishedAt),
    updatedAt: toIso(asset.updatedAt) ?? new Date().toISOString(),
    slug: asset.slug ?? undefined,
    locale: asset.locale as ContentAsset["locale"],
    assetType: asset.assetType as ContentAsset["assetType"],
    audience: asset.audience,
    seoTitle: asset.seoTitle,
    metaDescription: asset.metaDescription,
    faqs: Array.isArray(asset.faqs) ? (asset.faqs as ContentAsset["faqs"]) : [],
    schemaType: asset.schemaType as ContentAsset["schemaType"],
    ctaMode: asset.ctaMode as ContentAsset["ctaMode"],
    publishTarget: asset.publishTarget as ContentAsset["publishTarget"],
    isPublic: asset.isPublic,
    publishedPath: asset.publishedPath,
  };
}

export class PrismaGeoFlowBridgeRepository implements GeoFlowBridgeRepository {
  private readonly ownership?: OwnedContext;

  constructor(ownership?: OwnedContext) {
    this.ownership = ownership
      ? normalizeOwnership(ownership)
      : undefined;
  }

  private requireOwnership() {
    if (!this.ownership) {
      throw new Error(
        "Explicit ownership is required for GEOFlow persistence.",
      );
    }
    return this.ownership;
  }

  async ensureContentAsset(asset: ContentAsset) {
    const prisma = getPrisma();
    const ownership = this.requireOwnership();
    const existing = await prisma.contentAsset.findFirst({
      where: { id: asset.id, ...ownership },
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
      status: mapContentStatus(asset.status),
      geoScore: asset.geoScore,
      owner: asset.owner,
      sourceSystem: asset.sourceSystem ?? "geo_ops",
      externalUrl: asset.externalUrl ?? null,
      publishedAt: toDate(asset.publishedAt),
      slug: asset.slug ?? null,
      locale: asset.locale ?? "zh-CN",
      assetType: asset.assetType ?? "guide-page",
      audience: asset.audience ?? null,
      seoTitle: asset.seoTitle ?? null,
      metaDescription: asset.metaDescription ?? null,
      faqs: (asset.faqs ?? []) as object[],
      schemaType: asset.schemaType ?? "article",
      ctaMode: asset.ctaMode ?? "self_signup",
      publishTarget: asset.publishTarget ?? "geo_ops_internal",
      isPublic: asset.isPublic ?? false,
      publishedPath: asset.publishedPath ?? null,
    };
    if (existing) {
      const updated = await prisma.contentAsset.updateMany({
        where: { id: asset.id, ...ownership },
        data,
      });
      if (updated.count !== 1) {
        throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      }
    } else {
      await prisma.contentAsset.create({
        data: {
          ...ownership,
          ...data,
          id: asset.id,
        },
      });
    }
  }

  async findContentAsset(contentAssetId: string) {
    const asset = await getPrisma().contentAsset.findFirst({
      where: { id: contentAssetId, ...this.requireOwnership() },
    });
    return asset ? mapAsset(asset) : null;
  }

  async findPublicContentAsset(
    siteId: string,
    slug: string,
    locale: string,
    publishTarget = "txpuro",
  ) {
    const asset = await getPrisma().contentAsset.findFirst({
      where: { siteId, slug, locale, publishTarget, isPublic: true },
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
    });
    return asset ? mapAsset(asset) : null;
  }

  async listPublicContentAssets(siteId: string, publishTarget = "txpuro") {
    const assets = await getPrisma().contentAsset.findMany({
      where: { siteId, publishTarget, isPublic: true },
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
    });
    return assets.map(mapAsset);
  }

  async listContentAssets(options?: ListContentAssetsOptions) {
    const take = options?.take ?? 100;
    const cursor = options?.cursor;
    const assets = await getPrisma().contentAsset.findMany({
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return assets.map(mapAsset);
  }

  async seedContentAssets(assets: ContentAsset[]) {
    for (const asset of assets) {
      await this.ensureContentAsset(asset);
    }
  }

  async findLinkByIdempotencyKey(idempotencyKey: string) {
    const link = await getPrisma().geoFlowTaskLink.findFirst({
      where: { idempotencyKey, ...this.requireOwnership() },
      select: privateLinkSelect,
    });
    return link ? mapPrivateLink(link) : null;
  }

  async createLink(input: CreateGeoFlowTaskLinkInput) {
    const ownership = this.requireOwnership();
    const link = await getPrisma().geoFlowTaskLink.create({
      data: {
        ...ownership,
        contentAssetId: input.contentAssetId,
        idempotencyKey: input.idempotencyKey,
        status: input.status,
        taskPayload: input.taskPayload as object,
      },
      select: privateLinkSelect,
    });
    return mapPrivateLink(link);
  }

  async updateLink(id: string, input: UpdateGeoFlowTaskLinkInput) {
    const prisma = getPrisma();
    const ownership = this.requireOwnership();
    const updated = await prisma.geoFlowTaskLink.updateMany({
      where: { id, ...ownership },
      data: {
        ...(input.geoFlowTaskId !== undefined ? { geoFlowTaskId: input.geoFlowTaskId } : {}),
        ...(input.geoFlowJobId !== undefined ? { geoFlowJobId: input.geoFlowJobId } : {}),
        ...(input.geoFlowArticleId !== undefined ? { geoFlowArticleId: input.geoFlowArticleId } : {}),
        ...(input.geoFlowArticleUrl !== undefined
          ? { geoFlowArticleUrl: input.geoFlowArticleUrl }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.lastSyncedAt !== undefined ? { lastSyncedAt: toDate(input.lastSyncedAt) } : {}),
        ...(input.lastError !== undefined
          ? { lastError: stableGeoFlowErrorCode(input.lastError) }
          : {}),
      },
    });
    if (updated.count !== 1) {
      throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
    }
    const link = await prisma.geoFlowTaskLink.findFirst({
      where: { id, ...ownership },
      select: privateLinkSelect,
    });
    if (!link) {
      throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
    }
    return mapPrivateLink(link);
  }

  async listSyncableLinks(options?: ListSyncableLinksOptions) {
    const ownership = this.requireOwnership();
    const limit = syncPageLimit(options?.limit);
    if (options?.cursor) {
      const cursor = await getPrisma().geoFlowTaskLink.findFirst({
        where: { id: options.cursor, ...ownership },
        select: { id: true },
      });
      if (!cursor) throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
    }
    const links = await getPrisma().geoFlowTaskLink.findMany({
      where: {
        geoFlowTaskId: { not: null },
        status: { not: "published" },
        ...ownership,
      },
      orderBy: { id: "asc" },
      take: limit + 1,
      ...(options?.cursor
        ? { cursor: { id: options.cursor }, skip: 1 }
        : {}),
      select: privateLinkSelect,
    });
    return pageLinks(links.map(mapPrivateLink), limit);
  }

  async listLinks() {
    if (!isDatabaseConfigured()) {
      return [];
    }

    const links = await getPrisma().geoFlowTaskLink.findMany({
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: publicGeoFlowLinkSelect,
    });
    return links.map(toPublicGeoFlowLink);
  }

  async commitPublishedLink(
    id: string,
    input: PublishGeoFlowTaskLinkInput,
  ) {
    const ownership = this.requireOwnership();
    return getPrisma().$transaction(async (tx) => {
      const link = await tx.geoFlowTaskLink.findFirst({
        where: { id, ...ownership },
        select: privateLinkSelect,
      });
      if (!link) throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      if (link.status === "published") return mapPrivateLink(link);
      await tx.contentAsset.updateMany({
        where: { id: link.contentAssetId, ...ownership },
        data: {
          externalUrl: input.geoFlowArticleUrl,
          canonicalUrl: input.geoFlowArticleUrl,
          publishedAt: toDate(input.publishedAt),
          sourceSystem: "geoflow",
        },
      });
      const updated = await tx.geoFlowTaskLink.update({
        where: { id: link.id },
        data: {
          geoFlowJobId: input.geoFlowJobId,
          geoFlowArticleId: input.geoFlowArticleId,
          geoFlowArticleUrl: input.geoFlowArticleUrl,
          status: "published",
          lastSyncedAt: new Date(),
          lastError: null,
        },
        select: privateLinkSelect,
      });
      return mapPrivateLink(updated);
    });
  }

  async createSyncRun() {
    const run = await getPrisma().geoFlowSyncRun.create({
      data: this.requireOwnership(),
    });
    return { id: run.id };
  }

  async finishSyncRun(
    id: string,
    result: { successCount: number; failureCount: number; errorSummary?: string | null },
  ) {
    const updated = await getPrisma().geoFlowSyncRun.updateMany({
      where: { id, ...this.requireOwnership() },
      data: {
        finishedAt: new Date(),
        successCount: result.successCount,
        failureCount: result.failureCount,
        errorSummary: safeGeoFlowErrorSummary(result.errorSummary),
      },
    });
    if (updated.count !== 1) {
      throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
    }
  }
}

export function safeGeoFlowErrorSummary(value: string | null | undefined) {
  if (!value) {
    return value ?? null;
  }
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /\b(authorization|api[-_ ]?key|token|secret|password)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

export class ScopedPrismaGeoFlowBridgeRepository
  implements GeoFlowBridgeRepository
{
  private readonly business: PrismaBusinessRepository;
  private readonly syncOwnership?: OwnedContext;

  constructor(
    private readonly scope: AccessScope,
    private readonly request?: Request,
    syncOwnership?: OwnedContext,
    private readonly database: PrismaClient = db,
  ) {
    this.syncOwnership = syncOwnership
      ? normalizeOwnership(syncOwnership)
      : undefined;
    this.business = new PrismaBusinessRepository(database);
  }

  private async requiredEvents(
    tx: Prisma.TransactionClient,
    ownership: OwnedContext,
    action: string,
    entityType: string,
    entityId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    await createAuditEvent(tx, {
      actorId: this.scope.actorId,
      workspaceId: this.scope.workspaceId,
      ...ownership,
      action,
      entityType,
      entityId,
      outcome: "success",
      request: this.request,
      metadata: payload,
    });
    await createOutboxEvent(tx, {
      aggregateType: entityType,
      aggregateId: entityId,
      eventType,
      payload,
    });
  }

  async ensureContentAsset(asset: ContentAsset) {
    const existing = await this.business.findContentAsset(this.scope, asset.id);
    if (!existing) {
      throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
    }
  }

  async findContentAsset(contentAssetId: string) {
    return this.business.findContentAsset(this.scope, contentAssetId);
  }

  async findPublicContentAsset(
    siteId: string,
    slug: string,
    locale: string,
    publishTarget = "txpuro",
  ) {
    const asset = await this.database.contentAsset.findFirst({
      where: {
        siteId,
        slug,
        locale,
        publishTarget,
        isPublic: true,
        ...legacyScopeWhere(this.scope),
      },
    });
    return asset
      ? this.business.findContentAsset(this.scope, asset.id)
      : null;
  }

  async listPublicContentAssets(siteId: string, publishTarget = "txpuro") {
    const assets = await this.database.contentAsset.findMany({
      where: {
        siteId,
        publishTarget,
        isPublic: true,
        ...legacyScopeWhere(this.scope),
      },
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
      select: { id: true },
    });
    return Promise.all(
      assets.map(async ({ id }) => {
        const asset = await this.business.findContentAsset(this.scope, id);
        if (!asset) {
          throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
        }
        return asset;
      }),
    );
  }

  async listContentAssets(options?: ListContentAssetsOptions) {
    if (options?.cursor) {
      const cursor = await this.business.findContentAsset(
        this.scope,
        options.cursor,
      );
      if (!cursor) {
        throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      }
    }
    const assets = await this.database.contentAsset.findMany({
      where: legacyScopeWhere(this.scope),
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
      take: options?.take ?? 100,
      ...(options?.cursor
        ? { cursor: { id: options.cursor }, skip: 1 }
        : {}),
      select: { id: true },
    });
    return Promise.all(
      assets.map(async ({ id }) => {
        const asset = await this.business.findContentAsset(this.scope, id);
        if (!asset) {
          throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
        }
        return asset;
      }),
    );
  }

  async seedContentAssets() {
    throw new Error("Scoped GEOFlow repository does not seed content assets.");
  }

  async findLinkByIdempotencyKey(idempotencyKey: string) {
    const link = await this.database.geoFlowTaskLink.findFirst({
      where: { idempotencyKey, ...legacyScopeWhere(this.scope) },
      select: privateLinkSelect,
    });
    return link ? mapPrivateLink(link) : null;
  }

  async createLink(input: CreateGeoFlowTaskLinkInput) {
    return this.database.$transaction(async (tx) => {
      const asset = await tx.contentAsset.findFirst({
        where: {
          id: input.contentAssetId,
          ...legacyScopeWhere(this.scope),
        },
        select: {
          clientId: true,
          brandId: true,
          siteId: true,
          siteMarketId: true,
        },
      });
      if (!asset) {
        throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      }
      const link = await tx.geoFlowTaskLink.create({
        data: {
          ...asset,
          contentAssetId: input.contentAssetId,
          idempotencyKey: input.idempotencyKey,
          status: input.status,
          taskPayload: input.taskPayload as Prisma.InputJsonValue,
        },
        select: privateLinkSelect,
      });
      await this.requiredEvents(
        tx,
        asset,
        "geoflow.task.create",
        "GeoFlowTaskLink",
        link.id,
        "geoflow.task.created",
        { geoFlowTaskLinkId: link.id, contentAssetId: link.contentAssetId },
      );
      return mapPrivateLink(link);
    });
  }

  async updateLink(id: string, input: UpdateGeoFlowTaskLinkInput) {
    return this.database.$transaction(async (tx) => {
      const existing = await tx.geoFlowTaskLink.findFirst({
        where: { id, ...legacyScopeWhere(this.scope) },
        select: privateLinkSelect,
      });
      if (!existing) {
        throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      }
      const updated = await tx.geoFlowTaskLink.updateMany({
        where: { id, ...legacyScopeWhere(this.scope) },
        data: {
          ...(input.geoFlowTaskId !== undefined
            ? { geoFlowTaskId: input.geoFlowTaskId }
            : {}),
          ...(input.geoFlowJobId !== undefined
            ? { geoFlowJobId: input.geoFlowJobId }
            : {}),
          ...(input.geoFlowArticleId !== undefined
            ? { geoFlowArticleId: input.geoFlowArticleId }
            : {}),
          ...(input.geoFlowArticleUrl !== undefined
            ? { geoFlowArticleUrl: input.geoFlowArticleUrl }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.lastSyncedAt !== undefined
            ? { lastSyncedAt: toDate(input.lastSyncedAt) }
            : {}),
          ...(input.lastError !== undefined
            ? { lastError: stableGeoFlowErrorCode(input.lastError) }
            : {}),
        },
      });
      if (updated.count !== 1) {
        throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      }
      const link = await tx.geoFlowTaskLink.findFirst({
        where: { id, ...legacyScopeWhere(this.scope) },
        select: privateLinkSelect,
      });
      if (!link) {
        throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      }
      const ownership = {
        clientId: link.clientId,
        brandId: link.brandId,
        siteId: link.siteId,
        siteMarketId: link.siteMarketId,
      };
      await this.requiredEvents(
        tx,
        ownership,
        "geoflow.task.update",
        "GeoFlowTaskLink",
        link.id,
        "geoflow.task.updated",
        {
          geoFlowTaskLinkId: link.id,
          contentAssetId: link.contentAssetId,
          status: link.status,
        },
      );
      return mapPrivateLink(link);
    });
  }

  async listSyncableLinks(options?: ListSyncableLinksOptions) {
    const limit = syncPageLimit(options?.limit);
    const scopedWhere = {
      ...legacyScopeWhere(this.scope),
      ...(this.syncOwnership
        ? { siteId: this.syncOwnership.siteId }
        : {}),
    };
    if (options?.cursor) {
      const cursor = await this.database.geoFlowTaskLink.findFirst({
        where: { id: options.cursor, ...scopedWhere },
        select: { id: true },
      });
      if (!cursor) throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
    }
    const links = await this.database.geoFlowTaskLink.findMany({
      where: {
        geoFlowTaskId: { not: null },
        status: { not: "published" },
        ...scopedWhere,
      },
      orderBy: { id: "asc" },
      take: limit + 1,
      ...(options?.cursor
        ? { cursor: { id: options.cursor }, skip: 1 }
        : {}),
      select: privateLinkSelect,
    });
    return pageLinks(links.map(mapPrivateLink), limit);
  }

  async listLinks() {
    const links = await this.database.geoFlowTaskLink.findMany({
      where: legacyScopeWhere(this.scope),
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: publicGeoFlowLinkSelect,
    });
    return links.map(toPublicGeoFlowLink);
  }

  async commitPublishedLink(
    id: string,
    input: PublishGeoFlowTaskLinkInput,
  ) {
    return this.database.$transaction(async (tx) => {
      const existing = await tx.geoFlowTaskLink.findFirst({
        where: { id, ...legacyScopeWhere(this.scope) },
        select: privateLinkSelect,
      });
      if (!existing) {
        throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      }
      if (existing.status === "published") {
        return mapPrivateLink(existing);
      }
      const claimed = await tx.geoFlowTaskLink.updateMany({
        where: {
          id,
          status: { not: "published" },
          ...legacyScopeWhere(this.scope),
        },
        data: {
          geoFlowJobId: input.geoFlowJobId,
          geoFlowArticleId: input.geoFlowArticleId,
          geoFlowArticleUrl: input.geoFlowArticleUrl,
          status: "published",
          lastSyncedAt: new Date(),
          lastError: null,
        },
      });
      if (claimed.count === 0) {
        const replayed = await tx.geoFlowTaskLink.findFirst({
          where: { id, ...legacyScopeWhere(this.scope) },
          select: privateLinkSelect,
        });
        if (!replayed) throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
        return mapPrivateLink(replayed);
      }
      const asset = await tx.contentAsset.findFirst({
        where: {
          id: existing.contentAssetId,
          ...legacyScopeWhere(this.scope),
        },
        select: {
          id: true,
          clientId: true,
          brandId: true,
          siteId: true,
          siteMarketId: true,
        },
      });
      if (!asset) {
        throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      }
      const updated = await tx.contentAsset.updateMany({
        where: {
          id: existing.contentAssetId,
          ...legacyScopeWhere(this.scope),
        },
        data: {
          externalUrl: input.geoFlowArticleUrl,
          canonicalUrl: input.geoFlowArticleUrl,
          publishedAt: toDate(input.publishedAt),
          sourceSystem: "geoflow",
        },
      });
      if (updated.count !== 1) {
        throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      }
      await this.requiredEvents(
        tx,
        asset,
        "content_asset.publish",
        "ContentAsset",
        asset.id,
        "content_asset.published",
        { contentAssetId: asset.id, siteId: asset.siteId },
      );
      await this.requiredEvents(
        tx,
        asset,
        "geoflow.task.publish",
        "GeoFlowTaskLink",
        existing.id,
        "geoflow.task.published",
        {
          geoFlowTaskLinkId: existing.id,
          contentAssetId: asset.id,
          siteId: asset.siteId,
        },
      );
      const published = await tx.geoFlowTaskLink.findFirst({
        where: { id, ...legacyScopeWhere(this.scope) },
        select: privateLinkSelect,
      });
      if (!published) throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      return mapPrivateLink(published);
    });
  }

  async createSyncRun() {
    if (!this.syncOwnership) {
      throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
    }
    const ownership = this.syncOwnership;
    return this.database.$transaction(async (tx) => {
      const run = await tx.geoFlowSyncRun.create({
        data: ownership,
      });
      await this.requiredEvents(
        tx,
        ownership,
        "geoflow.sync.start",
        "GeoFlowSyncRun",
        run.id,
        "geoflow.sync.started",
        { geoFlowSyncRunId: run.id, siteId: run.siteId },
      );
      return { id: run.id };
    });
  }

  async finishSyncRun(
    id: string,
    result: {
      successCount: number;
      failureCount: number;
      errorSummary?: string | null;
    },
  ) {
    if (!this.syncOwnership) {
      throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
    }
    const ownership = this.syncOwnership;
    await this.database.$transaction(async (tx) => {
      const updated = await tx.geoFlowSyncRun.updateMany({
        where: {
          id,
          siteId: ownership.siteId,
          ...legacyScopeWhere(this.scope),
        },
        data: {
          finishedAt: new Date(),
          successCount: result.successCount,
          failureCount: result.failureCount,
          errorSummary: safeGeoFlowErrorSummary(result.errorSummary),
        },
      });
      if (updated.count !== 1) {
        throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      }
      await this.requiredEvents(
        tx,
        ownership,
        "geoflow.sync.finish",
        "GeoFlowSyncRun",
        id,
        "geoflow.sync.finished",
        {
          geoFlowSyncRunId: id,
          successCount: result.successCount,
          failureCount: result.failureCount,
        },
      );
    });
  }
}

export class InMemoryGeoFlowBridgeRepository implements GeoFlowBridgeRepository {
  private links = new Map<string, GeoFlowTaskLinkRecord>();
  private assets = new Map<string, ContentAsset>();
  private syncRunCount = 0;

  async ensureContentAsset(asset: ContentAsset) {
    this.assets.set(asset.id, asset);
  }

  async findContentAsset(contentAssetId: string) {
    return this.assets.get(contentAssetId) ?? null;
  }

  async findPublicContentAsset(
    _siteId: string,
    slug: string,
    locale: string,
    publishTarget = "txpuro",
  ) {
    return (
      Array.from(this.assets.values()).find(
        (asset) =>
          asset.slug === slug &&
          asset.locale === locale &&
          asset.publishTarget === publishTarget &&
          asset.isPublic,
      ) ?? null
    );
  }

  async listPublicContentAssets(_siteId: string, publishTarget = "txpuro") {
    return Array.from(this.assets.values()).filter(
      (asset) => asset.publishTarget === publishTarget && asset.isPublic,
    );
  }

  async listContentAssets(options?: ListContentAssetsOptions) {
    const all = Array.from(this.assets.values());
    const take = options?.take ?? all.length;
    const cursor = options?.cursor;
    const start = cursor ? all.findIndex((a) => a.id === cursor) + 1 : 0;
    return all.slice(start, start + take);
  }

  async seedContentAssets(assets: ContentAsset[]) {
    for (const asset of assets) {
      this.assets.set(asset.id, asset);
    }
  }

  async findLinkByIdempotencyKey(idempotencyKey: string) {
    return this.links.get(idempotencyKey) ?? null;
  }

  async createLink(input: CreateGeoFlowTaskLinkInput) {
    const link: GeoFlowTaskLinkRecord = {
      id: `link_${this.links.size + 1}`,
      contentAssetId: input.contentAssetId,
      geoFlowTaskId: null,
      geoFlowJobId: null,
      geoFlowArticleId: null,
      geoFlowArticleUrl: null,
      status: input.status,
      lastSyncedAt: null,
      lastError: null,
      idempotencyKey: input.idempotencyKey,
      taskPayload: input.taskPayload,
    };
    this.links.set(input.idempotencyKey, link);
    return link;
  }

  async updateLink(id: string, input: UpdateGeoFlowTaskLinkInput) {
    const current = Array.from(this.links.values()).find((link) => link.id === id);
    if (!current) {
      throw new Error(`Link ${id} not found`);
    }
    const updated = {
      ...current,
      ...input,
      ...(input.lastError !== undefined
        ? { lastError: stableGeoFlowErrorCode(input.lastError) }
        : {}),
      lastSyncedAt: toIso(input.lastSyncedAt),
    };
    this.links.set(current.idempotencyKey, updated);
    return updated;
  }

  async listSyncableLinks(options?: ListSyncableLinksOptions) {
    const limit = syncPageLimit(options?.limit);
    const allLinks = Array.from(this.links.values())
      .sort((left, right) => left.id.localeCompare(right.id));
    if (
      options?.cursor &&
      !allLinks.some(({ id }) => id === options.cursor)
    ) {
      throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
    }
    const links = allLinks
      .filter(
        (link) =>
          link.geoFlowTaskId !== null &&
          link.status !== "published" &&
          (!options?.cursor || link.id > options.cursor),
      );
    return pageLinks(links.slice(0, limit + 1), limit);
  }

  async listLinks() {
    return Array.from(this.links.values()).map(toPublicGeoFlowLink);
  }

  async commitPublishedLink(
    id: string,
    input: PublishGeoFlowTaskLinkInput,
  ) {
    const current = Array.from(this.links.values()).find((link) => link.id === id);
    if (!current) throw new Error(`Link ${id} not found`);
    if (current.status === "published") return current;
    const asset = this.assets.get(current.contentAssetId);
    if (asset) {
      this.assets.set(current.contentAssetId, {
        ...asset,
        externalUrl: input.geoFlowArticleUrl,
        canonicalUrl: input.geoFlowArticleUrl,
        publishedAt: toIso(input.publishedAt),
        sourceSystem: "geoflow",
      });
    }
    const published: GeoFlowTaskLinkRecord = {
      ...current,
      geoFlowJobId: input.geoFlowJobId,
      geoFlowArticleId: input.geoFlowArticleId,
      geoFlowArticleUrl: input.geoFlowArticleUrl,
      status: "published",
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    };
    this.links.set(current.idempotencyKey, published);
    return published;
  }

  async createSyncRun() {
    this.syncRunCount += 1;
    return { id: `sync_${this.syncRunCount}` };
  }

  async finishSyncRun() {}
}
