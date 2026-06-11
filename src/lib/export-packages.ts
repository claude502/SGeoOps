type AssetWithRelations = {
  id: string;
  title: string;
  summary: string;
  body: string;
  canonicalUrl: string;
  sourceUrl: string;
  publishedPath: string | null;
  geoScore: number;
  seoScore: number | null;
  locale: string;
  assetType: string;
  targetKeywords: string[];
  faqs: unknown;
  updatedAt: Date | string;
  createdAt?: Date | string;
  variants: Array<{
    platform: string;
    copy: string;
    mediaAssets: string[];
    metrics?: Array<{
      impressions: number;
      clicks: number;
      shares: number;
      recordedAt: Date | string;
    }>;
  }>;
  trendTopic?: {
    keyword: string;
    platform: string;
    score: number;
  } | null;
};

function toIso(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function asFaqArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function recommendedPlatforms(asset: AssetWithRelations) {
  return Array.from(new Set(asset.variants.map((variant) => variant.platform)));
}

function buildVariantMap(asset: AssetWithRelations) {
  return Object.fromEntries(
    asset.variants.map((variant) => [
      variant.platform,
      {
        copy: variant.copy,
        mediaAssets: variant.mediaAssets,
        latestMetrics: variant.metrics?.[0]
          ? {
              ...variant.metrics[0],
              recordedAt: toIso(variant.metrics[0].recordedAt),
            }
          : null,
      },
    ]),
  );
}

export function toExportPackageSummary(asset: AssetWithRelations) {
  return {
    id: `pkg_${asset.id}`,
    contentAssetId: asset.id,
    version: 1,
    language: asset.locale,
    status: "ready" as const,
    packageType: asset.assetType,
    title: asset.title,
    summary: asset.summary,
    canonicalUrl: asset.canonicalUrl,
    publishedPath: asset.publishedPath,
    sourceUrl: asset.sourceUrl,
    geoScore: asset.geoScore,
    seoScore: asset.seoScore,
    recommendedPlatforms: recommendedPlatforms(asset),
    updatedAt: toIso(asset.updatedAt),
  };
}

export function toExportPackageDetail(asset: AssetWithRelations) {
  return {
    id: `pkg_${asset.id}`,
    contentAssetId: asset.id,
    version: 1,
    language: asset.locale,
    status: "ready" as const,
    packageType: asset.assetType,
    title: asset.title,
    summary: asset.summary,
    body: asset.body,
    canonicalUrl: asset.canonicalUrl,
    publishedPath: asset.publishedPath,
    sourceUrl: asset.sourceUrl,
    geoScore: asset.geoScore,
    seoScore: asset.seoScore,
    targetKeywords: asset.targetKeywords,
    tags: asset.trendTopic
      ? [asset.trendTopic.keyword, asset.trendTopic.platform]
      : [],
    recommendedPlatforms: recommendedPlatforms(asset),
    variants: buildVariantMap(asset),
    videoScript: null,
    faq: asFaqArray(asset.faqs),
    riskNotes: [],
    sourceCitations: asset.trendTopic ? [asset.trendTopic.keyword] : [],
    trendTopic: asset.trendTopic ?? null,
    createdAt: toIso(asset.createdAt ?? asset.updatedAt),
    updatedAt: toIso(asset.updatedAt),
  };
}
