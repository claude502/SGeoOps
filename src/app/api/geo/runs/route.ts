import { NextResponse } from "next/server";
import { getRuntimeDashboardSnapshot } from "@/lib/dashboard-snapshot";

export async function GET() {
  const snapshot = await getRuntimeDashboardSnapshot();
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
    assets: snapshot.assets,
    variants: snapshot.variants,
    geoFlowLinks: snapshot.geoFlowLinks,
  });
}
