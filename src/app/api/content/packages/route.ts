import { NextResponse } from "next/server";

import { db } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform") ?? undefined;
  const cursor = searchParams.get("cursor") ?? undefined;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20", 10), 100);

  const assets = await db.contentAsset.findMany({
    where: {
      isPublic: true,
      status: "Ready",
      ...(platform ? { variants: { some: { platform } } } : {}),
    },
    include: {
      variants: {
        where: platform ? { platform } : undefined,
        include: { metrics: { orderBy: { recordedAt: "desc" }, take: 1 } },
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
}
