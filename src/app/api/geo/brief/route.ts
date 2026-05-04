import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/audit-log";
import { getRuntimeProject } from "@/lib/dashboard-snapshot";
import { createGeoBrief } from "@/lib/geo-engine";

const briefSchema = z.object({
  projectId: z.string().optional(),
  brand: z.string().min(1).optional(),
  product: z.string().optional(),
  keywords: z.array(z.string().min(1)).optional(),
  competitors: z.array(z.string().min(1)).optional(),
  audience: z.string().optional(),
  locale: z.string().optional(),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = briefSchema.safeParse(body);

  if (!parsed.success) {
    await recordAuditEvent({
      request,
      action: "geo.brief",
      entityType: "GeoBrief",
      outcome: "failure",
      metadata: { reason: "invalid_payload" },
    });
    return NextResponse.json(
      { error: "Invalid brief payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const project = await getRuntimeProject(parsed.data.projectId);
  if (!project) {
    await recordAuditEvent({
      request,
      action: "geo.brief",
      entityType: "GeoBrief",
      outcome: "failure",
      metadata: { reason: "project_not_found", projectId: parsed.data.projectId ?? null },
    });
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const brief = createGeoBrief({
    brand: parsed.data.brand || project.brand,
    product: parsed.data.product || project.product,
    keywords: parsed.data.keywords?.length ? parsed.data.keywords : project.targetKeywords,
    competitors: parsed.data.competitors?.length
      ? parsed.data.competitors
      : project.competitors,
    audience: parsed.data.audience,
    locale: parsed.data.locale || project.locale,
  });

  await recordAuditEvent({
    request,
    action: "geo.brief",
    entityType: "GeoBrief",
    entityId: brief.title,
    outcome: "success",
    metadata: {
      projectId: project.id,
      keywordCount: parsed.data.keywords?.length ?? project.targetKeywords.length,
      competitorCount: parsed.data.competitors?.length ?? project.competitors.length,
    },
  });

  return NextResponse.json({ brief });
}
