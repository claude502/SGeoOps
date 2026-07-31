import { NextResponse } from "next/server";

import { requireAccessScope, requireRole } from "@/lib/authorization";
import { organizationRouteError, readJson } from "@/lib/organization/http";
import { organizationRepository } from "@/lib/organization/repository";
import {
  createSiteSchema,
  pathIdSchema,
} from "@/lib/organization/schemas";

type RouteContext = {
  params: Promise<{ brandId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator"]);

    const brandId = pathIdSchema.safeParse((await context.params).brandId);
    const body = createSiteSchema.safeParse(await readJson(request));
    if (!brandId.success || !body.success) {
      return NextResponse.json(
        {
          error: "Invalid site",
          issues: body.success ? undefined : body.error.flatten(),
        },
        { status: 400 },
      );
    }

    const site = await organizationRepository.createSite(scope, {
      brandId: brandId.data,
      ...body.data,
    });
    return NextResponse.json({ site }, { status: 201 });
  } catch (error) {
    return organizationRouteError(error);
  }
}
