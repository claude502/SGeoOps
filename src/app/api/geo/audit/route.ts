import { NextResponse } from "next/server";
import { z } from "zod";
import { getRuntimeProject } from "@/lib/dashboard-snapshot";
import { runGeoAudit } from "@/lib/geo-engine";
import { addRuns } from "@/lib/geo-store";
import { providers } from "@/types/geo";

const auditSchema = z.object({
  projectId: z.string().optional(),
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

  const runs = runGeoAudit({
    project,
    content: parsed.data.content,
    url: parsed.data.url,
    prompts: parsed.data.prompts,
    provider: parsed.data.provider,
    locale: parsed.data.locale,
  });

  addRuns(runs);

  return NextResponse.json({
    mode: runs.every((run) => run.mode === "simulated") ? "simulated" : "provider",
    warning:
      runs.every((run) => run.mode === "simulated")
        ? "Provider API keys are not configured, so deterministic simulated runs were used."
        : null,
    runs,
  });
}
