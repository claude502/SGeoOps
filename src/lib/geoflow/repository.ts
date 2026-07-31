import type { Prisma, PrismaClient } from "@prisma/client";
import { createAuditEvent } from "@/lib/audit-log";
import type { AccessScope } from "@/lib/authorization";
import type { OwnedContext } from "@/lib/business/repository";
import { legacyScopeWhere, PrismaBusinessRepository } from "@/lib/business/repository";
import { ScopedBusinessError } from "@/lib/business/http";
import { createOutboxEvent } from "@/lib/events/outbox";
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

export interface ListContentAssetsOptions {
  take?: number;
  cursor?: string;
}

export interface GeoFlowBridgeRepository {
  ensureContentAsset(asset: ContentAsset): Promise<void>;
  findContentAsset(contentAssetId: string): Promise<ContentAsset | null>;
  findPublicContentAsset(slug: string, locale: string, publishTarget?: string): Promise<ContentAsset | null>;
  listContentAssets(options?: ListContentAssetsOptions): Promise<ContentAsset[]>;
  seedContentAssets(assets: ContentAsset[]): Promise<void>;
  findLinkByIdempotencyKey(idempotencyKey: string): Promise<GeoFlowTaskLinkRecord | null>;
  createLink(input: CreateGeoFlowTaskLinkInput): Promise<GeoFlowTaskLinkRecord>;
  updateLink(id: string, input: UpdateGeoFlowTaskLinkInput): Promise<GeoFlowTaskLinkRecord>;
  listSyncableLinks(): Promise<GeoFlowTaskLinkRecord[]>;
  listLinks(): Promise<GeoFlowTaskLinkView[]>;
  updateContentAssetPublication(
    contentAssetId: string,
    publication: { externalUrl: string; canonicalUrl: string; publishedAt: string | Date },
  ): Promise<void>;
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

function mapLink(link: {
  id: string;
  contentAssetId: string;
  geoFlowTaskId: number | null;
  geoFlowJobId: number | null;
  geoFlowArticleId: number | null;
  geoFlowArticleUrl: string | null;
  status: GeoFlowTaskStatus;
  lastSyncedAt: Date | string | null;
  lastError: string | null;
  idempotencyKey: string;
  taskPayload?: unknown;
}): GeoFlowTaskLinkRecord {
  return {
    id: link.id,
    contentAssetId: link.contentAssetId,
    geoFlowTaskId: link.geoFlowTaskId,
    geoFlowJobId: link.geoFlowJobId,
    geoFlowArticleId: link.geoFlowArticleId,
    geoFlowArticleUrl: link.geoFlowArticleUrl,
    status: link.status,
    lastSyncedAt: toIso(link.lastSyncedAt),
    lastError: link.lastError,
    idempotencyKey: link.idempotencyKey,
    taskPayload: link.taskPayload ?? null,
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

  async findPublicContentAsset(slug: string, locale: string, publishTarget = "txpuro") {
    const asset = await getPrisma().contentAsset.findFirst({
      where: { slug, locale, publishTarget, isPublic: true },
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
    });
    return asset ? mapAsset(asset) : null;
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
    });
    return link ? mapLink(link) : null;
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
    });
    return mapLink(link);
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
        ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
    }
    const link = await prisma.geoFlowTaskLink.findFirst({
      where: { id, ...ownership },
    });
    if (!link) {
      throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
    }
    return mapLink(link);
  }

  async listSyncableLinks() {
    const ownership = this.requireOwnership();
    const links = await getPrisma().geoFlowTaskLink.findMany({
      where: {
        geoFlowTaskId: { not: null },
        status: { not: "published" },
        ...ownership,
      },
      orderBy: { updatedAt: "desc" },
    });
    return links.map(mapLink);
  }

  async listLinks() {
    if (!isDatabaseConfigured()) {
      return [];
    }

    const links = await getPrisma().geoFlowTaskLink.findMany({
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return links.map(mapLink);
  }

  async updateContentAssetPublication(
    contentAssetId: string,
    publication: { externalUrl: string; canonicalUrl: string; publishedAt: string | Date },
  ) {
    const updated = await getPrisma().contentAsset.updateMany({
      where: { id: contentAssetId, ...this.requireOwnership() },
      data: {
        externalUrl: publication.externalUrl,
        canonicalUrl: publication.canonicalUrl,
        publishedAt: toDate(publication.publishedAt),
        sourceSystem: "geoflow",
      },
    });
    if (updated.count !== 1) {
      throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
    }
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
        errorSummary: result.errorSummary ?? null,
      },
    });
    if (updated.count !== 1) {
      throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
    }
  }
}

function safeErrorSummary(value: string | null | undefined) {
  if (!value) {
    return value ?? null;
  }
  return value
    .replace(
      /\b(authorization|api[-_ ]?key|token|secret|password)\b\s*[:=]\s*\S+/gi,
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
    slug: string,
    locale: string,
    publishTarget = "txpuro",
  ) {
    const asset = await this.database.contentAsset.findFirst({
      where: {
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
    });
    return link ? mapLink(link) : null;
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
      return mapLink(link);
    });
  }

  async updateLink(id: string, input: UpdateGeoFlowTaskLinkInput) {
    return this.database.$transaction(async (tx) => {
      const existing = await tx.geoFlowTaskLink.findFirst({
        where: { id, ...legacyScopeWhere(this.scope) },
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
            ? { lastError: safeErrorSummary(input.lastError) }
            : {}),
        },
      });
      if (updated.count !== 1) {
        throw new ScopedBusinessError("RESOURCE_NOT_FOUND");
      }
      const link = await tx.geoFlowTaskLink.findFirst({
        where: { id, ...legacyScopeWhere(this.scope) },
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
      return mapLink(link);
    });
  }

  async listSyncableLinks() {
    const links = await this.database.geoFlowTaskLink.findMany({
      where: {
        geoFlowTaskId: { not: null },
        status: { not: "published" },
        ...legacyScopeWhere(this.scope),
        ...(this.syncOwnership
          ? { siteId: this.syncOwnership.siteId }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
    });
    return links.map(mapLink);
  }

  async listLinks() {
    const links = await this.database.geoFlowTaskLink.findMany({
      where: legacyScopeWhere(this.scope),
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return links.map(mapLink);
  }

  async updateContentAssetPublication(
    contentAssetId: string,
    publication: {
      externalUrl: string;
      canonicalUrl: string;
      publishedAt: string | Date;
    },
  ) {
    await this.database.$transaction(async (tx) => {
      const asset = await tx.contentAsset.findFirst({
        where: { id: contentAssetId, ...legacyScopeWhere(this.scope) },
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
        where: { id: contentAssetId, ...legacyScopeWhere(this.scope) },
        data: {
          externalUrl: publication.externalUrl,
          canonicalUrl: publication.canonicalUrl,
          publishedAt: toDate(publication.publishedAt),
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
          errorSummary: safeErrorSummary(result.errorSummary),
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

  async findPublicContentAsset(slug: string, locale: string, publishTarget = "txpuro") {
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
    const updated = { ...current, ...input, lastSyncedAt: toIso(input.lastSyncedAt) };
    this.links.set(current.idempotencyKey, updated);
    return updated;
  }

  async listSyncableLinks() {
    return Array.from(this.links.values()).filter(
      (link) => link.geoFlowTaskId !== null && link.status !== "published",
    );
  }

  async listLinks() {
    return Array.from(this.links.values());
  }

  async updateContentAssetPublication(
    contentAssetId: string,
    publication: { externalUrl: string; canonicalUrl: string; publishedAt: string | Date },
  ) {
    const asset = this.assets.get(contentAssetId);
    if (asset) {
      this.assets.set(contentAssetId, {
        ...asset,
        externalUrl: publication.externalUrl,
        canonicalUrl: publication.canonicalUrl,
        publishedAt: toIso(publication.publishedAt),
        sourceSystem: "geoflow",
      });
    }
  }

  async createSyncRun() {
    this.syncRunCount += 1;
    return { id: `sync_${this.syncRunCount}` };
  }

  async finishSyncRun() {}
}
