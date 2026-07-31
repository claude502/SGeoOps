import { NextResponse } from "next/server";
import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";
import {
  txpuroProject,
  txpuroPrompts,
  txpuroStarterAssets,
} from "@/lib/txpuro";

export async function POST(request: Request) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin"]);
    const assets = txpuroStarterAssets();
    await new PrismaBusinessRepository().seedOwnedContentAssets(
      scope,
      "site_txpuro_com",
      assets,
      request,
    );

    return NextResponse.json({
      project: txpuroProject,
      prompts: txpuroPrompts,
      assets,
    });
  } catch (error) {
    return businessRouteError(error);
  }
}
