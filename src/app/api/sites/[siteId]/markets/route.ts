import { NextResponse } from "next/server";

import { requireAccessScope, requireRole } from "@/lib/authorization";
import { organizationRouteError, readJson } from "@/lib/organization/http";
import { organizationRepository } from "@/lib/organization/repository";
import {
  createSiteMarketSchema,
  pathIdSchema,
} from "@/lib/organization/schemas";

type RouteContext = {
  params: Promise<{ siteId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator"]);

    const siteId = pathIdSchema.safeParse((await context.params).siteId);
    const body = createSiteMarketSchema.safeParse(await readJson(request));
    if (!siteId.success || !body.success) {
      return NextResponse.json(
        {
          error: "Invalid site market",
          issues: body.success ? undefined : body.error.flatten(),
        },
        { status: 400 },
      );
    }

    const siteMarket = await organizationRepository.createSiteMarket(scope, {
      siteId: siteId.data,
      ...body.data,
    });
    return NextResponse.json({ siteMarket }, { status: 201 });
  } catch (error) {
    return organizationRouteError(error);
  }
}
