import { NextResponse } from "next/server";

import { requireAccessScope, requireRole } from "@/lib/authorization";
import { integrationRepository } from "@/lib/integrations/repository";
import { organizationRouteError, readJson } from "@/lib/organization/http";
import {
  createIntegrationSchema,
  pathIdSchema,
} from "@/lib/organization/schemas";

type RouteContext = {
  params: Promise<{ siteId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const scope = await requireAccessScope(request);
    const siteId = pathIdSchema.safeParse((await context.params).siteId);
    if (!siteId.success) {
      return NextResponse.json(
        { error: "Invalid site integration" },
        { status: 400 },
      );
    }

    const integrations = await integrationRepository.listBySite(
      scope,
      siteId.data,
    );
    return NextResponse.json({ integrations });
  } catch (error) {
    return organizationRouteError(error);
  }
}
export async function POST(request: Request, context: RouteContext) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin"]);

    const siteId = pathIdSchema.safeParse((await context.params).siteId);
    const body = createIntegrationSchema.safeParse(await readJson(request));
    if (!siteId.success || !body.success) {
      return NextResponse.json(
        {
          error: "Invalid integration",
          issues: body.success ? undefined : body.error.flatten(),
        },
        { status: 400 },
      );
    }

    const integration = await integrationRepository.create(scope, {
      siteId: siteId.data,
      ...body.data,
    });
    return NextResponse.json({ integration }, { status: 201 });
  } catch (error) {
    return organizationRouteError(error);
  }
}
