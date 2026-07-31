import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";

const schema = z.object({
  status: z.enum(["approved", "rejected"]),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Reviewer"]);
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

    const topic = await new PrismaBusinessRepository().updateTrendStatus(
      scope,
      id,
      parsed.data.status,
      request,
    );
    if (!topic) {
      return NextResponse.json(
        { error: "Trend topic not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(topic);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ScopedBusinessError" &&
      error.message === "RESOURCE_NOT_FOUND"
    ) {
      return NextResponse.json(
        { error: "Trend topic not found" },
        { status: 404 },
      );
    }
    return businessRouteError(error);
  }
}
