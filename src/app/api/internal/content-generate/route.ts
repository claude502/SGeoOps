import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { z } from "zod";

import { businessRouteError } from "@/lib/business/http";
import type { OwnedContext } from "@/lib/business/repository";
import { PrismaBusinessRepository } from "@/lib/business/repository";
import { generateChannelVariants } from "@/lib/geo-engine";
import { verifySignedInternalRequest } from "@/lib/internal-auth";
import { scoreDualContent } from "@/lib/seo/dual-optimizer";
import { buildTemplatePrompt, VIRAL_TEMPLATES } from "@/lib/viral/templates";
import { buildLeveragePrompt, isSafeKeyword } from "@/lib/viral/trend-leverage";
import type { ContentAsset, GeoProject, Provider } from "@/types/geo";

const schema = z.object({
  topicId: z.string().min(1),
  keyword: z.string().min(1).optional(),
  platform: z.string().min(1).optional(),
});

function pickTemplate(platform: string) {
  return (
    VIRAL_TEMPLATES.find((template) =>
      template.platforms.some(
        (supportedPlatform) =>
          supportedPlatform.toLowerCase() === platform.toLowerCase(),
      ),
    ) ?? VIRAL_TEMPLATES[0]
  );
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (!(await verifySignedInternalRequest(request, rawBody))) {
    return NextResponse.json(
      { error: "Internal authentication required" },
      { status: 401 },
    );
  }

  let body: unknown = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: "Invalid content-generate payload" },
      { status: 400 },
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid content-generate payload",
        issues: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const repository = new PrismaBusinessRepository();
  let trend;
  try {
    trend = await repository.findInternalTrend(parsed.data.topicId);
  } catch (error) {
    return businessRouteError(error);
  }
  if (!trend) {
    return NextResponse.json(
      { error: "Trend topic not found" },
      { status: 404 },
    );
  }

  if (!isSafeKeyword(trend.keyword)) {
    return NextResponse.json(
      { error: "Keyword is unsafe for automated content generation." },
      { status: 400 },
    );
  }

  const ownership: OwnedContext = {
    clientId: trend.clientId,
    brandId: trend.brandId,
    siteId: trend.siteId,
    siteMarketId: trend.siteMarketId,
  };
  const project: GeoProject = {
    id: trend.siteId,
    name: `${trend.site.name} Trend Engine`,
    brand: trend.site.brand.name,
    product: `${trend.site.brand.name} content system`,
    locale: "zh-CN",
    competitors: [],
    targetKeywords: [trend.keyword],
    canonicalDomain: trend.site.canonicalHost,
  };
  const provider: Provider = "ChatGPT";
  const template = pickTemplate(trend.platform);
  const publishedPath = `/guides/trend/${trend.id}`;
  const canonicalUrl = `https://${project.canonicalDomain}${publishedPath}`;
  const leverageBlock = buildLeveragePrompt({
    keyword: trend.keyword,
    productName: project.product,
    brand: project.brand,
    platform: trend.platform,
  });
  const templateBlock = buildTemplatePrompt(template, {
    productName: project.brand,
    keyword: trend.keyword,
    platform: trend.platform,
  });
  const title = `${trend.keyword} | ${project.brand} trend response`;
  const bodyText = [
    `${project.brand} can respond to the trend topic "${trend.keyword}" with a compliance-first, customer-friendly angle.`,
    "This generated draft ties current demand to a productized workflow, highlights practical evaluation criteria, and gives a clean handoff into guides or downstream distribution.",
    leverageBlock,
    templateBlock,
  ].join("\n\n");
  const summary = `Trend-driven content draft for ${trend.keyword} on ${trend.platform}.`;
  const scores = scoreDualContent({
    title,
    body: bodyText,
    targetKeywords: [trend.keyword],
    project,
    prompt: trend.keyword,
    provider,
  });
  const assetId = `asset_${nanoid(12)}`;
  const asset: ContentAsset & { seoScore: number } = {
    id: assetId,
    title,
    body: bodyText,
    summary,
    brandEntity: project.brand,
    sourceUrl: canonicalUrl,
    targetKeywords: [trend.keyword],
    canonicalUrl,
    status: "Ready",
    geoScore: scores.geoScore,
    seoScore: scores.seoScore,
    updatedAt: new Date().toISOString(),
    owner: "geo-worker",
    sourceSystem: "trend_engine",
    externalUrl: null,
    publishedAt: null,
    slug: `trend/${trend.id}`,
    locale: "zh-CN",
    assetType: "guide-page",
    audience: null,
    seoTitle: title,
    metaDescription: summary,
    faqs: [],
    schemaType: "article",
    ctaMode: "self_signup",
    publishTarget: "txpuro",
    isPublic: true,
    publishedPath,
  };
  const variants = generateChannelVariants({
    asset,
    platforms: ["Knowledge Site", "LinkedIn", "WeChat", "Xiaohongshu"],
    accountPrefix: "trend-engine",
  });

  try {
    const result = await repository.generateContentForTrend({
      trendId: trend.id,
      ownership,
      templateId: template.id,
      asset,
      variants,
      request,
    });
    return NextResponse.json(
      {
        contentAssetId: result.asset.id,
        variantCount: result.variantCount,
        geoScore: result.asset.geoScore,
        seoScore: result.seoScore,
        ...(result.reused ? { reused: true } : {}),
      },
      { status: result.reused ? 200 : 201 },
    );
  } catch (error) {
    return businessRouteError(error);
  }
}
