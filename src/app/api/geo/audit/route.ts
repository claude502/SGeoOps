import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";
import { runGeoAudit } from "@/lib/geo-engine";
import { providers } from "@/types/geo";

const auditSchema = z.object({
  projectId: z.string().optional(),
  siteId: z.string().optional(),
  contentAssetId: z.string().optional(),
  url: z.string().url().optional(),
  content: z.string().min(1).optional(),
  prompts: z.array(z.string().min(6)).max(20).optional(),
  provider: z.enum([...providers, "All"]).optional(),
  locale: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator"]);
    const body = await request.json().catch(() => null);
    const parsed = auditSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid audit payload", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const repository = new PrismaBusinessRepository();
    const asset = parsed.data.contentAssetId
      ? await repository.findContentAsset(
          scope,
          parsed.data.contentAssetId,
        )
      : null;

    if (parsed.data.contentAssetId && !asset) {
      return NextResponse.json(
        { error: "Content asset not found" },
        { status: 404 },
      );
    }

    const requestedSiteId =
      parsed.data.siteId ??
      (parsed.data.projectId === "proj_txpuro_workspace"
        ? "site_txpuro_com"
        : parsed.data.projectId);
    const siteId = asset?.siteId ?? requestedSiteId;
    if (!siteId) {
      return NextResponse.json(
        { error: "siteId or contentAssetId is required" },
        { status: 400 },
      );
    }
    if (
      asset &&
      requestedSiteId &&
      requestedSiteId !== asset.siteId &&
      !(
        parsed.data.projectId === "proj_txpuro_workspace" &&
        asset.siteId === "site_txpuro_com"
      )
    ) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 },
      );
    }
    const site = await repository.getSiteContext(scope, siteId);
    const project = {
      id: site.siteId,
      name: `${site.siteName} GEO Workspace`,
      brand: site.brandName,
      product: `${site.brandName} content system`,
      locale: parsed.data.locale ?? asset?.locale ?? "en",
      competitors: [],
      targetKeywords: asset?.targetKeywords ?? [],
      canonicalDomain: site.canonicalHost,
    };

    const runs = runGeoAudit({
      project,
      content: parsed.data.content ?? asset?.body,
      url: parsed.data.url,
      prompts: parsed.data.prompts,
      provider: parsed.data.provider,
      locale: parsed.data.locale,
    });

    const savedRuns = await repository.saveGeoRuns(
      scope,
      {
        siteId,
        contentAssetId: parsed.data.contentAssetId,
        runs,
      },
      request,
    );

    return NextResponse.json({
      mode: savedRuns.every((run) => run.mode === "simulated")
        ? "simulated"
        : "provider",
      warning:
        savedRuns.every((run) => run.mode === "simulated")
          ? "Provider API keys are not configured, so deterministic simulated runs were used."
          : null,
      runs: savedRuns,
    });
  } catch (error) {
    return businessRouteError(error);
  }
}
