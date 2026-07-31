import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";
import { ScopedPrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { createGeoFlowBridgeService, integrationErrorResponse } from "@/lib/geoflow/server";

const geoBriefSchema = z.object({
  title: z.string().min(1),
  objective: z.string().min(1),
  searchIntent: z.string().min(1),
  entityCoverage: z.array(z.string()),
  outline: z.array(z.string()),
  faq: z.array(z.string()),
  comparisonAngles: z.array(z.string()),
  schemaSuggestions: z.array(z.string()),
});

const sendTaskSchema = z.object({
  contentAssetId: z.string().min(1),
  brief: geoBriefSchema.optional().nullable(),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator"]);
    const body = await request.json().catch(() => null);
    const parsed = sendTaskSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid GEOFlow task payload",
          issues: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    const asset = await new PrismaBusinessRepository().findContentAsset(
      scope,
      parsed.data.contentAssetId,
    );
    if (!asset) {
      return NextResponse.json(
        { error: "Content asset not found" },
        { status: 404 },
      );
    }

    const result = await createGeoFlowBridgeService(
      new ScopedPrismaGeoFlowBridgeRepository(scope, request),
    ).sendToGeoFlow({
      asset,
      brief: parsed.data.brief ?? null,
    });

    return NextResponse.json(result, { status: result.reused ? 200 : 201 });
  } catch (error) {
    const response = integrationErrorResponse(error);
    if (response.status === 500) {
      return businessRouteError(error);
    }
    return NextResponse.json(response.body, { status: response.status });
  }
}
