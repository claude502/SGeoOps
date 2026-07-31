import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";
import { createGeoBrief } from "@/lib/geo-engine";
import { contentAssetTypes } from "@/types/geo";

const briefSchema = z.object({
  projectId: z.string().optional(),
  siteId: z.string().optional(),
  brand: z.string().min(1).optional(),
  product: z.string().optional(),
  keywords: z.array(z.string().min(1)).optional(),
  competitors: z.array(z.string().min(1)).optional(),
  audience: z.string().max(500).optional(),
  locale: z.string().optional(),
  assetType: z.enum(contentAssetTypes).optional(),
});

export async function POST(request: Request) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator", "Reviewer"]);
    const body = await request.json().catch(() => null);
    const parsed = briefSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid brief payload", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const siteId =
      parsed.data.siteId ??
      (parsed.data.projectId === "proj_txpuro_workspace"
        ? "site_txpuro_com"
        : parsed.data.projectId);
    if (!siteId) {
      return NextResponse.json(
        { error: "siteId is required" },
        { status: 400 },
      );
    }
    const repository = new PrismaBusinessRepository();
    const site = await repository.getSiteContext(scope, siteId);
    const project = {
      id: site.siteId,
      name: `${site.siteName} GEO Workspace`,
      brand: site.brandName,
      product: `${site.brandName} content system`,
      locale: parsed.data.locale ?? "en",
      competitors: [],
      targetKeywords: [] as string[],
      canonicalDomain: site.canonicalHost,
    };

    const brief = createGeoBrief({
      brand: parsed.data.brand || project.brand,
      product: parsed.data.product || project.product,
      keywords: parsed.data.keywords?.length
        ? parsed.data.keywords
        : project.targetKeywords,
      competitors: parsed.data.competitors?.length
        ? parsed.data.competitors
        : project.competitors,
      audience: parsed.data.audience,
      locale: parsed.data.locale || project.locale,
      assetType: parsed.data.assetType,
    });

    await repository.recordBriefGenerated(
      scope,
      siteId,
      {
        projectId: project.id,
        keywordCount:
          parsed.data.keywords?.length ?? project.targetKeywords.length,
        competitorCount:
          parsed.data.competitors?.length ?? project.competitors.length,
      },
      request,
    );

    return NextResponse.json({ brief });
  } catch (error) {
    return businessRouteError(error);
  }
}
