import { NextResponse } from "next/server";

import { toExportPackageSummary } from "@/lib/export-packages";
import { db } from "@/lib/prisma";

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

  if (status !== "ready") {
    return NextResponse.json({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  }

  try {
    const assets = await db.contentAsset.findMany({
      where: {
        isPublic: true,
        status: "Ready",
        ...(language ? { locale: language } : {}),
        ...(platform ? { variants: { some: { platform } } } : {}),
      },
      select: {
        id: true,
        title: true,
        summary: true,
        body: true,
        canonicalUrl: true,
        sourceUrl: true,
        publishedPath: true,
        geoScore: true,
        seoScore: true,
        locale: true,
        assetType: true,
        targetKeywords: true,
        faqs: true,
        createdAt: true,
        updatedAt: true,
        variants: {
          where: platform ? { platform } : undefined,
          select: {
            platform: true,
            copy: true,
            mediaAssets: true,
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
    const items = (hasMore ? assets.slice(0, limit) : assets).map(
      toExportPackageSummary,
    );

    return NextResponse.json({
      items,
      nextCursor: hasMore ? items.at(-1)?.contentAssetId ?? null : null,
      hasMore,
    });
  } catch (err) {
    console.error("[/api/export-packages] DB error:", err);
    return NextResponse.json(
      { error: "Failed to load export packages. Please try again." },
      { status: 503 },
    );
  }
}
