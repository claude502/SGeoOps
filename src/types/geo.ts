export const providers = ["ChatGPT", "Perplexity", "Gemini", "Claude"] as const;
export const channelPlatforms = [
  "Knowledge Site",
  "LinkedIn",
  "X",
  "WeChat",
  "Xiaohongshu",
] as const;
export const contentLocales = ["zh-CN", "en"] as const;
export const contentAssetTypes = [
  "money-page",
  "feature-page",
  "guide-page",
  "compare-page",
  "faq-page",
] as const;
export const schemaTypes = ["product", "faq", "article"] as const;
export const ctaModes = ["self_signup", "demo", "contact"] as const;
export const publishTargets = ["txpuro", "geo_ops_internal"] as const;

export type Provider = (typeof providers)[number];
export type ChannelPlatform = (typeof channelPlatforms)[number];
export type ContentLocale = (typeof contentLocales)[number];
export type ContentAssetType = (typeof contentAssetTypes)[number];
export type SchemaType = (typeof schemaTypes)[number];
export type CtaMode = (typeof ctaModes)[number];
export type PublishTarget = (typeof publishTargets)[number];
export type ContentStatus = "Draft" | "Review" | "Ready" | "Scheduled";
export type VariantStatus = "Draft" | "Review" | "Ready" | "Scheduled" | "Published";
export type GeoFlowTaskStatus =
  | "not_sent"
  | "queued"
  | "generating"
  | "reviewing"
  | "published"
  | "failed";
export type GeoRecommendationKind =
  | "llms.txt"
  | "schema"
  | "FAQ"
  | "comparison"
  | "content-brief"
  | "source-citation";

export interface GeoProject {
  id: string;
  name: string;
  brand: string;
  product: string;
  locale: string;
  competitors: string[];
  targetKeywords: string[];
  canonicalDomain: string;
}

export interface ContentAsset {
  id: string;
  title: string;
  body: string;
  summary: string;
  brandEntity: string;
  sourceUrl: string;
  targetKeywords: string[];
  canonicalUrl: string;
  status: ContentStatus;
  geoScore: number;
  updatedAt: string;
  owner: string;
  sourceSystem?: string;
  externalUrl?: string | null;
  publishedAt?: string | null;
  slug?: string;
  locale?: ContentLocale;
  assetType?: ContentAssetType;
  audience?: string | null;
  seoTitle?: string | null;
  metaDescription?: string | null;
  faqs?: Array<{ question: string; answer: string }>;
  schemaType?: SchemaType;
  ctaMode?: CtaMode;
  publishTarget?: PublishTarget;
  isPublic?: boolean;
  publishedPath?: string | null;
}

export interface ChannelVariant {
  id: string;
  contentAssetId: string;
  platform: ChannelPlatform;
  accountId: string;
  copy: string;
  mediaAssets: string[];
  scheduledAt: string | null;
  status: VariantStatus;
}

export interface GeoRecommendation {
  id: string;
  kind: GeoRecommendationKind;
  title: string;
  detail: string;
  priority: "High" | "Medium" | "Low";
}

export interface GEORun {
  id: string;
  projectId: string;
  contentAssetId?: string | null;
  prompt: string;
  provider: Provider;
  locale: string;
  competitors: string[];
  modelAnswer: string;
  brandMentioned: boolean;
  citedDomains: string[];
  score: number;
  recommendations: GeoRecommendation[];
  createdAt: string;
  mode: "simulated" | "provider";
}

export interface GeoBrief {
  title: string;
  objective: string;
  searchIntent: string;
  entityCoverage: string[];
  outline: string[];
  faq: string[];
  comparisonAngles: string[];
  schemaSuggestions: string[];
}

export interface ProviderHealth {
  provider: Provider;
  status: "Configured" | "Simulated";
  latencyMs: number;
  lastRunAt: string;
}

export interface GeoFlowTaskLinkView {
  id: string;
  contentAssetId: string;
  geoFlowTaskId: number | null;
  geoFlowJobId: number | null;
  geoFlowArticleId: number | null;
  geoFlowArticleUrl: string | null;
  status: GeoFlowTaskStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
  idempotencyKey: string;
}

export interface AuditEventView {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: "success" | "failure";
  requestId: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface DashboardSnapshot {
  project: GeoProject;
  assets: ContentAsset[];
  variants: ChannelVariant[];
  runs: GEORun[];
  providerHealth: ProviderHealth[];
  geoFlowLinks: GeoFlowTaskLinkView[];
  auditEvents: AuditEventView[];
}
