import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { z } from "zod";

import { generateChannelVariants } from "@/lib/geo-engine";
import { saveChannelVariants } from "@/lib/geo-persistence";
import { db } from "@/lib/prisma";
import { scoreDualContent } from "@/lib/seo/dual-optimizer";
import { buildTemplatePrompt, VIRAL_TEMPLATES } from "@/lib/viral/templates";
import { buildLeveragePrompt, isSafeKeyword } from "@/lib/viral/trend-leverage";
import type { GeoProject, Provider } from "@/types/geo";

const schema = z.object({
  topicId: z.string().min(1),
  keyword: z.string().min(1),
  platform: z.string().min(1),
});

function getTxpuroProject(): GeoProject {
  const canonicalDomain = process.env.TXPURO_PUBLIC_HOST ?? "txpuro.com";

  return {
    id: "proj_txpuro_trend_engine",
    name: "Txpuro Trend Engine",
    brand: "Txpuro",
    product: "Txpuro E-Invoice System",
    locale: "zh-CN",
    competitors: ["MyInvois Portal", "manual process", "custom integration"],
    targetKeywords: ["Malaysia e-Invoice", "LHDN e-Invoice deadline", "MyInvois"],
    canonicalDomain,
  };
}

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

async function ensureVariantsForAsset(asset: {
  id: string;
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  brandEntity?: string | null;
}) {
  const existingVariantCount = await db.channelVariant.count({
    where: { contentAssetId: asset.id },
  });

  if (existingVariantCount > 0) {
    return existingVariantCount;
  }

  const variants = generateChannelVariants({
    asset: {
      id: asset.id,
      title: asset.title ?? "Trend content",
      summary: asset.summary ?? "",
      body: asset.body ?? "",
      brandEntity: asset.brandEntity ?? "Txpuro",
    },
    platforms: ["Knowledge Site", "LinkedIn", "WeChat", "Xiaohongshu"],
    accountPrefix: "trend-engine",
  });

  await saveChannelVariants(variants);
  return variants.length;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid content-generate payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!isSafeKeyword(parsed.data.keyword)) {
    return NextResponse.json(
      { error: "Keyword is unsafe for automated content generation." },
      { status: 400 },
    );
  }

  const trend = await db.trendTopic.findUnique({
    where: { id: parsed.data.topicId },
  });

  if (!trend) {
    return NextResponse.json({ error: "Trend topic not found" }, { status: 404 });
  }

  const project = getTxpuroProject();
  const provider: Provider = "ChatGPT";
  const template = pickTemplate(parsed.data.platform);
  const publishedPath = `/guides/trend/${trend.id}`;
  const canonicalUrl = `https://${project.canonicalDomain}${publishedPath}`;

  const existingAsset = await db.contentAsset.findFirst({
    where: {
      trendTopicId: parsed.data.topicId,
      sourceSystem: "trend_engine",
      templateId: template.id,
    },
    select: {
      id: true,
      title: true,
      summary: true,
      body: true,
      brandEntity: true,
      geoScore: true,
      seoScore: true,
    },
  });

  if (existingAsset) {
    const variantCount = await ensureVariantsForAsset(existingAsset);

    return NextResponse.json(
      {
        contentAssetId: existingAsset.id,
        variantCount,
        geoScore: existingAsset.geoScore ?? 0,
        seoScore: existingAsset.seoScore ?? 0,
        reused: true,
      },
      { status: 200 },
    );
  }

  const leverageBlock = buildLeveragePrompt({
    keyword: parsed.data.keyword,
    productName: project.product,
    brand: project.brand,
    platform: parsed.data.platform,
  });
  const templateBlock = buildTemplatePrompt(template, {
    productName: project.brand,
    keyword: parsed.data.keyword,
    platform: parsed.data.platform,
  });

  const title = `${parsed.data.keyword} | ${project.brand} trend response`;
  const bodyText = [
    `${project.brand} can respond to the trend topic "${parsed.data.keyword}" with a compliance-first, SME-friendly angle.`,
    "This generated draft ties current demand to a productized workflow, highlights practical evaluation criteria, and gives a clean handoff into guides or downstream distribution.",
    leverageBlock,
    templateBlock,
  ].join("\n\n");
  const summary = `Trend-driven content draft for ${parsed.data.keyword} on ${parsed.data.platform}.`;
  const scores = scoreDualContent({
    title,
    body: bodyText,
    targetKeywords: [parsed.data.keyword, ...project.targetKeywords],
    project,
    prompt: parsed.data.keyword,
    provider,
  });

  const asset = await db.contentAsset.create({
    data: {
      id: `asset_${nanoid(12)}`,
      title,
      body: bodyText,
      summary,
      brandEntity: project.brand,
      sourceUrl: canonicalUrl,
      targetKeywords: [parsed.data.keyword, ...project.targetKeywords],
      canonicalUrl,
      status: "Ready",
      geoScore: scores.geoScore,
      seoScore: scores.seoScore,
      owner: "geo-worker",
      sourceSystem: "trend_engine",
      locale: project.locale,
      assetType: "guide-page",
      seoTitle: title,
      metaDescription: summary,
      faqs: [],
      schemaType: "article",
      ctaMode: "self_signup",
      publishTarget: "txpuro",
      isPublic: true,
      publishedPath,
      trendTopicId: parsed.data.topicId,
      templateId: template.id,
    },
    select: { id: true, title: true, summary: true, body: true, brandEntity: true },
  });

  const variantCount = await ensureVariantsForAsset({
    id: asset.id,
    title: asset.title ?? title,
    summary: asset.summary ?? summary,
    body: asset.body ?? bodyText,
    brandEntity: asset.brandEntity ?? project.brand,
  });

  return NextResponse.json(
    {
      contentAssetId: asset.id,
      variantCount,
      geoScore: scores.geoScore,
      seoScore: scores.seoScore,
    },
    { status: 201 },
  );
}
