import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";
import { generateChannelVariants } from "@/lib/geo-engine";
import { handoffVariantsToPostiz } from "@/lib/postiz-handoff";
import { channelPlatforms } from "@/types/geo";

const variantSchema = z.object({
  contentAssetId: z.string().optional(),
  assetId: z.string().optional(),
  content: z
    .object({
      title: z.string().min(1),
      summary: z.string().min(1),
      body: z.string().min(1),
      brandEntity: z.string().min(1),
    })
    .optional(),
  siteId: z.string().min(1).optional(),
  platforms: z.array(z.enum(channelPlatforms)).optional(),
  accountPrefix: z.string().optional(),
  handoffToPostiz: z.boolean().optional(),
});

export async function POST(request: Request) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator"]);
    const body = await request.json().catch(() => null);
    const parsed = variantSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid variant payload", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const resolvedAssetId = parsed.data.contentAssetId ?? parsed.data.assetId;
    const repository = new PrismaBusinessRepository();

    const asset = resolvedAssetId
      ? await repository.findContentAsset(scope, resolvedAssetId)
      : parsed.data.content && parsed.data.siteId
        ? { id: "ad_hoc_asset", ...parsed.data.content }
        : null;

    if (!asset) {
      if (resolvedAssetId) {
        return NextResponse.json(
          { error: "Content asset not found" },
          { status: 404 },
        );
      }
      return NextResponse.json(
        {
          error:
            "Provide an owned contentAssetId, or inline content with siteId.",
        },
        { status: 400 },
      );
    }

    const variants = generateChannelVariants({
      asset,
      platforms:
        parsed.data.platforms ?? [
          "Knowledge Site",
          "LinkedIn",
          "X",
          "WeChat",
        ],
      accountPrefix: parsed.data.accountPrefix,
    });

    if (!resolvedAssetId) {
      return NextResponse.json(
        { error: "Inline content persistence requires a content asset." },
        { status: 422 },
      );
    }
    const savedVariants = await repository.saveChannelVariants(
      scope,
      resolvedAssetId,
      variants,
      request,
    );

    const handoff = parsed.data.handoffToPostiz
      ? await handoffVariantsToPostiz(savedVariants)
      : {
          status: "not-configured" as const,
          message: "Variants were saved locally and are ready for review.",
          variants: savedVariants,
        };

    return NextResponse.json({ variants: savedVariants, handoff });
  } catch (error) {
    return businessRouteError(error);
  }
}
