import { PrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { getDashboardSnapshot } from "@/lib/geo-store";
import { isDatabaseConfigured } from "@/lib/prisma";
import type { ContentAsset, DashboardSnapshot, GeoProject, ProviderHealth } from "@/types/geo";
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

export async function getRuntimeDashboardSnapshot(): Promise<DashboardSnapshot> {
  const memorySnapshot = getDashboardSnapshot();

  if (!isDatabaseConfigured()) {
    return memorySnapshot;
  }

  const repository = new PrismaGeoFlowBridgeRepository();
  const [geoFlowLinks, assets] = await Promise.all([
    repository.listLinks().catch(() => []),
    repository.listContentAssets().catch(() => []),
  ]);
  const project = getProjectFromEnvironment(assets);
  const assetIds = new Set(assets.map((asset) => asset.id));

  return {
    project,
    providerHealth: providerHealthFromEnv(),
    runs: memorySnapshot.runs.filter((run) => run.projectId === project.id),
    assets,
    variants: memorySnapshot.variants.filter((variant) => assetIds.has(variant.contentAssetId)),
    geoFlowLinks,
  };
}

export async function getRuntimeProject(projectId?: string) {
  const snapshot = await getRuntimeDashboardSnapshot();
  return !projectId || projectId === snapshot.project.id ? snapshot.project : null;
}
