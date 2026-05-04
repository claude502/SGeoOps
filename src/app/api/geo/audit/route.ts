import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/audit-log";
import { getRuntimeProject } from "@/lib/dashboard-snapshot";
import { runGeoAudit } from "@/lib/geo-engine";
import { PrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { saveGeoRuns } from "@/lib/geo-persistence";
import { getAsset } from "@/lib/geo-store";
import { isDatabaseConfigured } from "@/lib/prisma";
import { providers } from "@/types/geo";

const auditSchema = z.object({
  projectId: z.string().optional(),
  contentAssetId: z.string().optional(),
  url: z.string().url().optional(),
  content: z.string().min(1).optional(),
  prompts: z.array(z.string().min(6)).max(20).optional(),
  provider: z.enum([...providers, "All"]).optional(),
  locale: z.string().optional(),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = auditSchema.safeParse(body);

  if (!parsed.success) {
    await recordAuditEvent({
      request,
      action: "geo.audit",
      entityType: "GeoRun",
      outcome: "failure",
      metadata: { reason: "invalid_payload" },
    });
    return NextResponse.json(
      { error: "Invalid audit payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const project = await getRuntimeProject(parsed.data.projectId);
  if (!project) {
    await recordAuditEvent({
      request,
      action: "geo.audit",
      entityType: "GeoRun",
      outcome: "failure",
      metadata: { reason: "project_not_found", projectId: parsed.data.projectId ?? null },
    });
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const asset = parsed.data.contentAssetId
    ? isDatabaseConfigured()
      ? await new PrismaGeoFlowBridgeRepository().findContentAsset(parsed.data.contentAssetId)
      : getAsset(parsed.data.contentAssetId)
    : null;

  if (parsed.data.contentAssetId && !asset) {
    await recordAuditEvent({
      request,
      action: "geo.audit",
      entityType: "GeoRun",
      outcome: "failure",
      metadata: { reason: "content_asset_not_found", contentAssetId: parsed.data.contentAssetId },
    });
    return NextResponse.json({ error: "Content asset not found" }, { status: 404 });
  }

  const runs = runGeoAudit({
    project,
    content: parsed.data.content ?? asset?.body,
    url: parsed.data.url,
    prompts: parsed.data.prompts,
    provider: parsed.data.provider,
    locale: parsed.data.locale,
  });

  const savedRuns = await saveGeoRuns(runs, parsed.data.contentAssetId);
  await recordAuditEvent({
    request,
    action: "geo.audit",
    entityType: parsed.data.contentAssetId ? "ContentAsset" : "GeoRun",
    entityId: parsed.data.contentAssetId ?? savedRuns[0]?.id,
    outcome: "success",
    metadata: {
      projectId: project.id,
      runCount: savedRuns.length,
      provider: parsed.data.provider ?? "All",
      mode: savedRuns.every((run) => run.mode === "simulated") ? "simulated" : "provider",
    },
  });

  return NextResponse.json({
    mode: savedRuns.every((run) => run.mode === "simulated") ? "simulated" : "provider",
    warning:
      savedRuns.every((run) => run.mode === "simulated")
        ? "Provider API keys are not configured, so deterministic simulated runs were used."
        : null,
    runs: savedRuns,
  });
}
