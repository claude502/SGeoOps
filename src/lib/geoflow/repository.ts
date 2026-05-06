import type { ContentAsset, GeoFlowTaskLinkView, GeoFlowTaskStatus } from "@/types/geo";
import { getPrisma, isDatabaseConfigured } from "@/lib/prisma";

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
  async ensureContentAsset(asset: ContentAsset) {
    const prisma = getPrisma();
    await prisma.contentAsset.upsert({
      where: { id: asset.id },
      create: {
        id: asset.id,
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
      },
      update: {
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
      },
    });
  }

  async findContentAsset(contentAssetId: string) {
    const asset = await getPrisma().contentAsset.findUnique({ where: { id: contentAssetId } });
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
    const link = await getPrisma().geoFlowTaskLink.findUnique({ where: { idempotencyKey } });
    return link ? mapLink(link) : null;
  }

  async createLink(input: CreateGeoFlowTaskLinkInput) {
    const link = await getPrisma().geoFlowTaskLink.create({
      data: {
        contentAssetId: input.contentAssetId,
        idempotencyKey: input.idempotencyKey,
        status: input.status,
        taskPayload: input.taskPayload as object,
      },
    });
    return mapLink(link);
  }

  async updateLink(id: string, input: UpdateGeoFlowTaskLinkInput) {
    const link = await getPrisma().geoFlowTaskLink.update({
      where: { id },
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
    return mapLink(link);
  }

  async listSyncableLinks() {
    const links = await getPrisma().geoFlowTaskLink.findMany({
      where: { geoFlowTaskId: { not: null }, status: { not: "published" } },
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
    await getPrisma().contentAsset.update({
      where: { id: contentAssetId },
      data: {
        externalUrl: publication.externalUrl,
        canonicalUrl: publication.canonicalUrl,
        publishedAt: toDate(publication.publishedAt),
        sourceSystem: "geoflow",
      },
    });
  }

  async createSyncRun() {
    const run = await getPrisma().geoFlowSyncRun.create({ data: {} });
    return { id: run.id };
  }

  async finishSyncRun(
    id: string,
    result: { successCount: number; failureCount: number; errorSummary?: string | null },
  ) {
    await getPrisma().geoFlowSyncRun.update({
      where: { id },
      data: {
        finishedAt: new Date(),
        successCount: result.successCount,
        failureCount: result.failureCount,
        errorSummary: result.errorSummary ?? null,
      },
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
