import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/audit-log";
import { buildContentAsset, contentAssetInputSchema } from "@/lib/content-assets";
import { PrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { upsertAsset } from "@/lib/geo-store";
import { isDatabaseConfigured } from "@/lib/prisma";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = contentAssetInputSchema.safeParse(body);

  if (!parsed.success) {
    await recordAuditEvent({
      request,
      action: "content_asset.create",
      entityType: "ContentAsset",
      outcome: "failure",
      metadata: { reason: "invalid_payload" },
    });
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

  await recordAuditEvent({
    request,
    action: "content_asset.create",
    entityType: "ContentAsset",
    entityId: asset.id,
    outcome: "success",
    metadata: {
      title: asset.title,
      keywordCount: asset.targetKeywords.length,
      sourceSystem: asset.sourceSystem,
    },
  });

  return NextResponse.json({ asset }, { status: 201 });
}
