import { NextResponse } from "next/server";

import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator", "Reviewer", "Viewer"]);
    const { id } = await params;
    const asset = await new PrismaBusinessRepository().getContentPackage(
      scope,
      id,
    );

    if (!asset) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const platforms = Object.fromEntries(
      asset.variants.map((variant) => [
        variant.platform,
        {
          copy: variant.copy,
          mediaAssets: variant.mediaAssets,
          latestMetrics: variant.metrics[0] ?? null,
        },
      ]),
    );

    return NextResponse.json({
      id: asset.id,
      title: asset.title,
      summary: asset.summary,
      geoScore: asset.geoScore,
      seoScore: asset.seoScore,
      trendTopic: asset.trendTopic,
      platforms,
    });
  } catch (error) {
    return businessRouteError(error);
  }
}
