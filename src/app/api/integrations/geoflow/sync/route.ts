import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";
import { ScopedPrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { createGeoFlowBridgeService, integrationErrorResponse } from "@/lib/geoflow/server";

export const dynamic = "force-dynamic";

const schema = z.object({
  siteId: z.string().min(1),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(25).optional(),
});

export async function POST(request: Request) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator"]);
    const parsed = schema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid GEOFlow sync payload", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const ownership = await new PrismaBusinessRepository().getSiteContext(
      scope,
      parsed.data.siteId,
    );
    const result = await createGeoFlowBridgeService(
      new ScopedPrismaGeoFlowBridgeRepository(
        scope,
        request,
        ownership,
      ),
    ).sync({ cursor: parsed.data.cursor, limit: parsed.data.limit });
    return NextResponse.json(result);
  } catch (error) {
    const response = integrationErrorResponse(error);
    if (response.status === 500) {
      return businessRouteError(error);
    }
    return NextResponse.json(response.body, { status: response.status });
  }
}
