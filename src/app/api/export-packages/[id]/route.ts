import { NextResponse } from "next/server";

import { toExportPackageDetail } from "@/lib/export-packages";
import { db } from "@/lib/prisma";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const assetId = id.replace(/^pkg_/, "");

  try {
    const asset = await db.contentAsset.findUnique({
      where: { id: assetId },
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
          select: {
            platform: true,
            copy: true,
            mediaAssets: true,
            metrics: { orderBy: { recordedAt: "desc" }, take: 5 },
          },
        },
        trendTopic: true,
      },
    });

    if (!asset || !asset.canonicalUrl) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(toExportPackageDetail(asset));
  } catch (err) {
    console.error("[/api/export-packages/:id] DB error:", err);
    return NextResponse.json(
      { error: "Failed to load export package. Please try again." },
      { status: 503 },
    );
  }
}
