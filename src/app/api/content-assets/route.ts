import { NextResponse } from "next/server";
import { z } from "zod";
import { PrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { upsertAsset } from "@/lib/geo-store";
import { isDatabaseConfigured } from "@/lib/prisma";
import type { ContentAsset } from "@/types/geo";

const assetSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  summary: z.string().optional(),
  brandEntity: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  targetKeywords: z.union([z.array(z.string().min(1)), z.string()]).optional(),
  canonicalUrl: z.string().url(),
  owner: z.string().optional(),
});

function slug(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function keywords(input: string[] | string | undefined) {
  if (Array.isArray(input)) {
    return input.map((item) => item.trim()).filter(Boolean);
  }
  return (input ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = assetSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid content asset payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const asset: ContentAsset = {
    id: `asset_${slug(parsed.data.title) || "content"}_${Date.now()}`,
    title: parsed.data.title,
    body: parsed.data.body,
    summary: parsed.data.summary?.trim() || parsed.data.body.replace(/\s+/g, " ").slice(0, 180),
    brandEntity: parsed.data.brandEntity,
    sourceUrl: parsed.data.sourceUrl || parsed.data.canonicalUrl,
    targetKeywords: keywords(parsed.data.targetKeywords),
    canonicalUrl: parsed.data.canonicalUrl,
    status: "Draft",
    geoScore: 0,
    updatedAt: now,
    owner: parsed.data.owner?.trim() || "GEO Ops",
    sourceSystem: "geo_ops",
    externalUrl: null,
    publishedAt: null,
  };

  if (isDatabaseConfigured()) {
    await new PrismaGeoFlowBridgeRepository().ensureContentAsset(asset);
  } else {
    upsertAsset(asset);
  }

  return NextResponse.json({ asset }, { status: 201 });
}
