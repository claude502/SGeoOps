import { NextResponse } from "next/server";
import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";
import {
  buildContentAsset,
  scopedContentAssetInputSchema,
} from "@/lib/content-assets";

export async function POST(request: Request) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator"]);
    const body = await request.json().catch(() => null);
    const parsed = scopedContentAssetInputSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid content asset payload",
          issues: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    const asset = buildContentAsset(parsed.data);
    const created = await new PrismaBusinessRepository().createContentAsset(
      scope,
      parsed.data.siteId,
      asset,
      request,
    );

    return NextResponse.json({ asset: created }, { status: 201 });
  } catch (error) {
    return businessRouteError(error);
  }
}
