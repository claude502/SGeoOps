import { NextResponse } from "next/server";

import { requireAccessScope, requireRole } from "@/lib/authorization";
import { organizationRouteError, readJson } from "@/lib/organization/http";
import { organizationRepository } from "@/lib/organization/repository";
import {
  createBrandSchema,
  pathIdSchema,
} from "@/lib/organization/schemas";

type RouteContext = {
  params: Promise<{ clientId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator"]);

    const clientId = pathIdSchema.safeParse((await context.params).clientId);
    const body = createBrandSchema.safeParse(await readJson(request));
    if (!clientId.success || !body.success) {
      return NextResponse.json(
        {
          error: "Invalid brand",
          issues: body.success ? undefined : body.error.flatten(),
        },
        { status: 400 },
      );
    }

    const brand = await organizationRepository.createBrand(scope, {
      clientId: clientId.data,
      ...body.data,
    });
    return NextResponse.json({ brand }, { status: 201 });
  } catch (error) {
    return organizationRouteError(error);
  }
}
