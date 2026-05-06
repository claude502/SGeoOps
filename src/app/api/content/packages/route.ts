import { NextResponse } from "next/server";

import { db } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform") ?? undefined;
  const cursor = searchParams.get("cursor") ?? undefined;
  const requestedLimit = parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 20;

  try {
    const assets = await db.contentAsset.findMany({
      where: {
        isPublic: true,
        status: "Ready",
        ...(platform ? { variants: { some: { platform } } } : {}),
      },
      select: {
        id: true,
        title: true,
        summary: true,
        geoScore: true,
        seoScore: true,
        locale: true,
        assetType: true,
        publishedAt: true,
        updatedAt: true,
        variants: {
          where: platform ? { platform } : undefined,
          select: {
            id: true,
            platform: true,
            copy: true,
            mediaAssets: true,
            status: true,
            scheduledAt: true,
            metrics: { orderBy: { recordedAt: "desc" }, take: 1 },
          },
        },
        trendTopic: { select: { keyword: true, platform: true, score: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = assets.length > limit;
    const items = hasMore ? assets.slice(0, limit) : assets;

    return NextResponse.json({
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
      hasMore,
    });
  } catch (err) {
    console.error("[/api/content/packages] DB error:", err);
    return NextResponse.json(
      { error: "Failed to load content packages. Please try again." },
      { status: 503 },
    );
  }
}
