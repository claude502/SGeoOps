import { NextResponse } from "next/server";
import { buildContentAsset, contentAssetInputSchema } from "@/lib/content-assets";
import { PrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { upsertAsset } from "@/lib/geo-store";
import { isDatabaseConfigured } from "@/lib/prisma";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = contentAssetInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid content asset payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const asset = buildContentAsset(parsed.data);

  if (isDatabaseConfigured()) {
    await new PrismaGeoFlowBridgeRepository().ensureContentAsset(asset);
  } else {
    upsertAsset(asset);
  }

  return NextResponse.json({ asset }, { status: 201 });
}
