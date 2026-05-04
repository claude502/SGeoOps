import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/audit-log";
import { createGeoFlowBridgeService, integrationErrorResponse } from "@/lib/geoflow/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const result = await createGeoFlowBridgeService().sync();
    await recordAuditEvent({
      request,
      action: "geoflow.sync",
      entityType: "GeoFlowSyncRun",
      outcome: "success",
      metadata: {
        successCount: result.successCount,
        failureCount: result.failureCount,
        linkCount: result.links.length,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    await recordAuditEvent({
      request,
      action: "geoflow.sync",
      entityType: "GeoFlowSyncRun",
      outcome: "failure",
      metadata: { reason: error instanceof Error ? error.message : "geoflow_sync_failed" },
    });
    const response = integrationErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
