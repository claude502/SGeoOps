import { NextResponse } from "next/server";

import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform") ?? undefined;
  const cursor = searchParams.get("cursor") ?? undefined;
  const requestedLimit = parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 20;

  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator", "Reviewer", "Viewer"]);
    const assets = await new PrismaBusinessRepository().listContentPackages(
      scope,
      {
        platform,
        cursor,
        limit,
      },
    );

    const hasMore = assets.length > limit;
    const items = hasMore ? assets.slice(0, limit) : assets;

    return NextResponse.json({
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
      hasMore,
    });
  } catch (err) {
    return businessRouteError(err);
  }
}
