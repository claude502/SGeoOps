import { NextResponse } from "next/server";
import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository, recommendations } from "@/lib/business/repository";
import { getProjectFromEnvironment } from "@/lib/dashboard-snapshot";

export async function GET(request: Request) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator", "Reviewer", "Viewer"]);
    const data = await new PrismaBusinessRepository().listDashboardData(
      scope,
    );
    const runs = data.runs.map((run) => ({
      ...run,
      createdAt: run.createdAt.toISOString(),
      recommendations: recommendations(run.recommendations),
    }));
    const scoresByProvider = runs.reduce<Record<string, number[]>>(
      (acc, run) => {
        acc[run.provider] = [...(acc[run.provider] || []), run.score];
        return acc;
      },
      {},
    );

    const providerAverages = Object.fromEntries(
      Object.entries(scoresByProvider).map(([provider, scores]) => [
        provider,
        Math.round(
          scores.reduce((sum, score) => sum + score, 0) / scores.length,
        ),
      ]),
    );

    return NextResponse.json({
      project: getProjectFromEnvironment(data.assets),
      providerHealth: [],
      providerAverages,
      runs,
      assets: data.assets,
      variants: data.variants,
      geoFlowLinks: data.links,
      auditEvents: data.audits,
    });
  } catch (error) {
    return businessRouteError(error);
  }
}
