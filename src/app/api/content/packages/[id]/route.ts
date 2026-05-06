import { NextResponse } from "next/server";

import { db } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const asset = await db.contentAsset.findUnique({
    where: { id },
    include: {
      variants: {
        include: { metrics: { orderBy: { recordedAt: "desc" }, take: 5 } },
      },
      trendTopic: true,
    },
  });

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
}
