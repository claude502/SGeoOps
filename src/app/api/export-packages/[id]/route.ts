import { NextResponse } from "next/server";

import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";
import { toExportPackageDetail } from "@/lib/export-packages";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const assetId = id.replace(/^pkg_/, "");

  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator", "Reviewer", "Viewer"]);
    const asset = await new PrismaBusinessRepository().getExportAsset(
      scope,
      assetId,
    );

    if (!asset || !asset.canonicalUrl) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(toExportPackageDetail(asset));
  } catch (err) {
    return businessRouteError(err);
  }
}
