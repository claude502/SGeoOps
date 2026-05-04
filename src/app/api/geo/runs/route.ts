import { NextResponse } from "next/server";
import { PrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { getDashboardSnapshot } from "@/lib/geo-store";
import { isDatabaseConfigured } from "@/lib/prisma";

export async function GET() {
  const snapshot = getDashboardSnapshot();
  const repository = isDatabaseConfigured() ? new PrismaGeoFlowBridgeRepository() : null;
  const [geoFlowLinks, persistentAssets] = repository
    ? await Promise.all([
        repository.listLinks().catch(() => []),
        repository.listContentAssets().catch(() => []),
      ])
    : [[], []];
  const assets = persistentAssets.length > 0 ? persistentAssets : snapshot.assets;
  const scoresByProvider = snapshot.runs.reduce<Record<string, number[]>>((acc, run) => {
    acc[run.provider] = [...(acc[run.provider] || []), run.score];
    return acc;
  }, {});

  const providerAverages = Object.fromEntries(
    Object.entries(scoresByProvider).map(([provider, scores]) => [
      provider,
      Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length),
    ]),
  );

  return NextResponse.json({
    project: snapshot.project,
    providerHealth: snapshot.providerHealth,
    providerAverages,
    runs: snapshot.runs,
    assets,
    variants: snapshot.variants,
    geoFlowLinks,
  });
}
