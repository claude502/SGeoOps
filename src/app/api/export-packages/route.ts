import { NextResponse } from "next/server";

import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";
import { toExportPackageSummary } from "@/lib/export-packages";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform") ?? undefined;
  const language = searchParams.get("language") ?? undefined;
  const status = searchParams.get("status") ?? "ready";
  const cursor = searchParams.get("cursor")?.replace(/^pkg_/, "") ?? undefined;
  const requestedLimit = parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 20;

  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator", "Reviewer", "Viewer"]);
    if (status !== "ready") {
      return NextResponse.json({
        items: [],
        nextCursor: null,
        hasMore: false,
      });
    }
    const assets = await new PrismaBusinessRepository().listExportAssets(
      scope,
      { platform, language, cursor, limit },
    );

    const hasMore = assets.length > limit;
    const items = (hasMore ? assets.slice(0, limit) : assets).map(
      toExportPackageSummary,
    );

    return NextResponse.json({
      items,
      nextCursor: hasMore ? items.at(-1)?.contentAssetId ?? null : null,
      hasMore,
    });
  } catch (err) {
    return businessRouteError(err);
  }
}
