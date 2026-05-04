import { NextResponse } from "next/server";
import { z } from "zod";
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
    return NextResponse.json(
      { error: "Invalid audit payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const project = await getRuntimeProject(parsed.data.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const asset = parsed.data.contentAssetId
    ? isDatabaseConfigured()
      ? await new PrismaGeoFlowBridgeRepository().findContentAsset(parsed.data.contentAssetId)
      : getAsset(parsed.data.contentAssetId)
    : null;

  if (parsed.data.contentAssetId && !asset) {
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

  return NextResponse.json({
    mode: savedRuns.every((run) => run.mode === "simulated") ? "simulated" : "provider",
    warning:
      savedRuns.every((run) => run.mode === "simulated")
        ? "Provider API keys are not configured, so deterministic simulated runs were used."
        : null,
    runs: savedRuns,
  });
}
