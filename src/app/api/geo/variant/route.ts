import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/audit-log";
import { generateChannelVariants } from "@/lib/geo-engine";
import { PrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { saveChannelVariants } from "@/lib/geo-persistence";
import { addVariants, getAsset } from "@/lib/geo-store";
import { handoffVariantsToPostiz } from "@/lib/postiz-handoff";
import { isDatabaseConfigured } from "@/lib/prisma";
import { channelPlatforms } from "@/types/geo";

const variantSchema = z.object({
  contentAssetId: z.string().optional(),
  content: z
    .object({
      title: z.string().min(1),
      summary: z.string().min(1),
      body: z.string().min(1),
      brandEntity: z.string().min(1),
    })
    .optional(),
  platforms: z.array(z.enum(channelPlatforms)).optional(),
  accountPrefix: z.string().optional(),
  handoffToPostiz: z.boolean().optional(),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = variantSchema.safeParse(body);

  if (!parsed.success) {
    await recordAuditEvent({
      request,
      action: "geo.variant",
      entityType: "ChannelVariant",
      outcome: "failure",
      metadata: { reason: "invalid_payload" },
    });
    return NextResponse.json(
      { error: "Invalid variant payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const asset = parsed.data.contentAssetId
    ? isDatabaseConfigured()
      ? await new PrismaGeoFlowBridgeRepository().findContentAsset(parsed.data.contentAssetId)
      : getAsset(parsed.data.contentAssetId)
    : parsed.data.content
      ? { id: "ad_hoc_asset", ...parsed.data.content }
      : null;

  if (!asset) {
    await recordAuditEvent({
      request,
      action: "geo.variant",
      entityType: "ChannelVariant",
      outcome: "failure",
      metadata: { reason: "missing_content", contentAssetId: parsed.data.contentAssetId ?? null },
    });
    return NextResponse.json(
      { error: "Provide contentAssetId for an existing asset or an inline content object." },
      { status: 400 },
    );
  }

  const variants = generateChannelVariants({
    asset,
    platforms: parsed.data.platforms ?? ["Knowledge Site", "LinkedIn", "X", "WeChat"],
    accountPrefix: parsed.data.accountPrefix,
  });

  const savedVariants =
    isDatabaseConfigured() && parsed.data.contentAssetId
      ? await saveChannelVariants(variants)
      : (addVariants(variants), variants);

  const handoff = parsed.data.handoffToPostiz
    ? await handoffVariantsToPostiz(savedVariants)
    : {
        status: "not-configured" as const,
        message: "Variants were saved locally and are ready for review.",
        variants: savedVariants,
      };

  await recordAuditEvent({
    request,
    action: "geo.variant",
    entityType: parsed.data.contentAssetId ? "ContentAsset" : "ChannelVariant",
    entityId: parsed.data.contentAssetId ?? savedVariants[0]?.id,
    outcome: "success",
    metadata: {
      variantCount: savedVariants.length,
      platforms: savedVariants.map((variant) => variant.platform),
      handoffStatus: handoff.status,
    },
  });

  return NextResponse.json({ variants: savedVariants, handoff });
}
