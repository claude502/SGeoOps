import type {
  ChannelVariant,
  ContentAsset,
  DashboardSnapshot,
  GEORun,
  GeoProject,
  GeoFlowTaskLinkView,
  ProviderHealth,
} from "@/types/geo";
import { initialSnapshot } from "@/lib/sample-data";

interface StoreState {
  project: GeoProject;
  assets: ContentAsset[];
  variants: ChannelVariant[];
  runs: GEORun[];
  providerHealth: ProviderHealth[];
  geoFlowLinks: GeoFlowTaskLinkView[];
  auditEvents: DashboardSnapshot["auditEvents"];
}

const globalForStore = globalThis as typeof globalThis & {
  __geoOpsStore?: StoreState;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function state() {
  if (!globalForStore.__geoOpsStore) {
    globalForStore.__geoOpsStore = clone(initialSnapshot);
  }

  return globalForStore.__geoOpsStore;
}

export function getDashboardSnapshot(): DashboardSnapshot {
  return clone(state());
}

export function getProject(projectId?: string) {
  const current = state().project;
  return !projectId || projectId === current.id ? current : null;
}

export function getAssets() {
  return clone(state().assets);
}

export function getAsset(assetId: string) {
  return state().assets.find((asset) => asset.id === assetId) ?? null;
}

export function addRuns(runs: GEORun[]) {
  const current = state();
  current.runs = [...runs, ...current.runs].slice(0, 200);

  const latestByProvider = new Map(
    current.providerHealth.map((health) => [health.provider, health]),
  );

  for (const run of runs) {
    latestByProvider.set(run.provider, {
      provider: run.provider,
      status: run.mode === "provider" ? "Configured" : "Simulated",
      latencyMs: 600 + Math.floor(run.score * 7),
      lastRunAt: run.createdAt,
    });
  }

  current.providerHealth = Array.from(latestByProvider.values());
}

export function addVariants(variants: ChannelVariant[]) {
  const current = state();
  current.variants = [...variants, ...current.variants].slice(0, 100);
}

export function upsertAsset(asset: ContentAsset) {
  const current = state();
  const existingIndex = current.assets.findIndex((item) => item.id === asset.id);
  if (existingIndex >= 0) {
    current.assets[existingIndex] = asset;
    return;
  }

  current.assets = [asset, ...current.assets].slice(0, 100);
}
