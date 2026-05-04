import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/audit-log";
import { PrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { createGeoFlowBridgeService, integrationErrorResponse } from "@/lib/geoflow/server";
import { getAsset } from "@/lib/geo-store";
import { isDatabaseConfigured } from "@/lib/prisma";

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
  const body = await request.json().catch(() => null);
  const parsed = sendTaskSchema.safeParse(body);

  if (!parsed.success) {
    await recordAuditEvent({
      request,
      action: "geoflow.task.send",
      entityType: "GeoFlowTaskLink",
      outcome: "failure",
      metadata: { reason: "invalid_payload" },
    });
    return NextResponse.json(
      { error: "Invalid GEOFlow task payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const asset = isDatabaseConfigured()
    ? (await new PrismaGeoFlowBridgeRepository()
        .findContentAsset(parsed.data.contentAssetId)
      .catch(() => null)) ?? getAsset(parsed.data.contentAssetId)
    : getAsset(parsed.data.contentAssetId);
  if (!asset) {
    await recordAuditEvent({
      request,
      action: "geoflow.task.send",
      entityType: "ContentAsset",
      entityId: parsed.data.contentAssetId,
      outcome: "failure",
      metadata: { reason: "content_asset_not_found" },
    });
    return NextResponse.json({ error: "Content asset not found" }, { status: 404 });
  }

  try {
    const result = await createGeoFlowBridgeService().sendToGeoFlow({
      asset,
      brief: parsed.data.brief ?? null,
    });

    await recordAuditEvent({
      request,
      action: "geoflow.task.send",
      entityType: "GeoFlowTaskLink",
      entityId: result.link.id,
      outcome: "success",
      metadata: {
        contentAssetId: asset.id,
        geoFlowTaskId: result.link.geoFlowTaskId,
        status: result.link.status,
        reused: result.reused,
      },
    });

    return NextResponse.json(result, { status: result.reused ? 200 : 201 });
  } catch (error) {
    await recordAuditEvent({
      request,
      action: "geoflow.task.send",
      entityType: "ContentAsset",
      entityId: asset.id,
      outcome: "failure",
      metadata: { reason: error instanceof Error ? error.message : "geoflow_task_failed" },
    });
    const response = integrationErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
