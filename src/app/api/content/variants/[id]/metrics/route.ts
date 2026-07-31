import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";

const schema = z.object({
  impressions: z.number().int().min(0),
  clicks: z.number().int().min(0),
  shares: z.number().int().min(0),
  recordedAt: z.string().datetime().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator"]);
    const { id } = await params;
    const parsed = schema.safeParse(
      await request.json().catch(() => null),
    );

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const metric = await new PrismaBusinessRepository().createVariantMetric(
      scope,
      id,
      parsed.data,
      request,
    );
    return NextResponse.json(metric, { status: 201 });
  } catch (error) {
    return businessRouteError(error);
  }
}
