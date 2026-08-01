import type { AccessScope } from "@/lib/authorization";
import { PrismaBusinessRepository } from "@/lib/business/repository";
import { getDashboardSnapshot } from "@/lib/geo-store";
import { isDatabaseConfigured } from "@/lib/prisma";
import { txpuroProject } from "@/lib/txpuro";
import type {
  AuditEventView,
  ChannelVariant,
  ContentAsset,
  DashboardSnapshot,
  GEORun,
  GeoProject,
  GeoRecommendation,
  ProviderHealth,
} from "@/types/geo";
import { providers } from "@/types/geo";

function splitList(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function domainFromUrl(value: string | undefined) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function unique(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)));
}

export function getProjectFromEnvironment(assets: ContentAsset[] = []): GeoProject {
  const txpuroAssets = assets.filter((asset) => asset.publishTarget === "txpuro");
  if (!process.env.GEO_PROJECT_ID && txpuroAssets.length) {
    return {
      ...txpuroProject,
      targetKeywords: unique(txpuroAssets.flatMap((asset) => asset.targetKeywords)).slice(0, 20),
    };
  }

  const firstAsset = assets[0];
  const keywordsFromAssets = unique(assets.flatMap((asset) => asset.targetKeywords));
  const domain =
    process.env.GEO_CANONICAL_DOMAIN ||
    domainFromUrl(firstAsset?.canonicalUrl) ||
    domainFromUrl(firstAsset?.sourceUrl) ||
    "configure-domain.local";
  const brand = process.env.GEO_BRAND || firstAsset?.brandEntity || "Your Brand";

  return {
    id: process.env.GEO_PROJECT_ID || "proj_real_workspace",
    name: process.env.GEO_PROJECT_NAME || `${brand} GEO Workspace`,
    brand,
    product: process.env.GEO_PRODUCT || `${brand} content system`,
    locale: process.env.GEO_LOCALE || "zh-CN",
    competitors: splitList(process.env.GEO_COMPETITORS),
    targetKeywords: splitList(process.env.GEO_TARGET_KEYWORDS).length
      ? splitList(process.env.GEO_TARGET_KEYWORDS)
      : keywordsFromAssets,
    canonicalDomain: domain,
  };
}

function providerHealthFromEnv(): ProviderHealth[] {
  const envKeys = {
    ChatGPT: "OPENAI_API_KEY",
    Perplexity: "PERPLEXITY_API_KEY",
    Gemini: "GEMINI_API_KEY",
    Claude: "ANTHROPIC_API_KEY",
  } as const;

  return providers.map((provider) => ({
    provider,
    status: process.env[envKeys[provider]] ? "Configured" : "Simulated",
    latencyMs: 0,
    lastRunAt: "",
  }));
}

function toIso(value: Date | string | null) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function recommendations(value: unknown): GeoRecommendation[] {
  return Array.isArray(value) ? (value as GeoRecommendation[]) : [];
}

function serializeRun(run: {
  createdAt: Date | string;
  recommendations: unknown;
  provider: string;
  mode: string;
  [key: string]: unknown;
}): GEORun {
  return {
    ...run,
    provider: run.provider as GEORun["provider"],
    mode: run.mode as GEORun["mode"],
    recommendations: recommendations(run.recommendations),
    createdAt: toIso(run.createdAt) ?? new Date().toISOString(),
  } as GEORun;
}

function serializeVariant(variant: {
  scheduledAt: Date | string | null;
  platform: string;
  status: string;
  [key: string]: unknown;
}): ChannelVariant {
  return {
    ...variant,
    platform: variant.platform as ChannelVariant["platform"],
    status: variant.status as ChannelVariant["status"],
    scheduledAt: toIso(variant.scheduledAt),
  } as ChannelVariant;
}

function serializeAuditEvent(event: {
  outcome: string;
  createdAt: Date | string;
  [key: string]: unknown;
}): AuditEventView {
  return {
    ...event,
    outcome: event.outcome === "failure" ? "failure" : "success",
    createdAt: toIso(event.createdAt) ?? new Date().toISOString(),
  } as AuditEventView;
}

export async function getRuntimeDashboardSnapshot(
  scope?: AccessScope,
): Promise<DashboardSnapshot> {
  const memorySnapshot = getDashboardSnapshot();

  if (!isDatabaseConfigured() || !scope?.clientIds.length) {
    return memorySnapshot;
  }

  const data = await new PrismaBusinessRepository().listDashboardData(scope);

  return {
    project: getProjectFromEnvironment(data.assets),
    providerHealth: providerHealthFromEnv(),
    runs: data.runs.map(serializeRun),
    assets: data.assets,
    variants: data.variants.map(serializeVariant),
    geoFlowLinks: data.links,
    auditEvents: data.audits.map(serializeAuditEvent),
  };
}

export async function getRuntimeProject(projectId?: string) {
  const snapshot = await getRuntimeDashboardSnapshot();
  return !projectId || projectId === snapshot.project.id ? snapshot.project : null;
}
