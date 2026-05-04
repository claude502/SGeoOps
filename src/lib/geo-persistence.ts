import type { ChannelVariant, GEORun, GeoRecommendation } from "@/types/geo";
import type { Prisma } from "@prisma/client";
import { getPrisma, isDatabaseConfigured } from "@/lib/prisma";
import { addRuns, addVariants } from "@/lib/geo-store";

type GeoRunRow = {
  id: string;
  projectId: string;
  contentAssetId: string | null;
  prompt: string;
  provider: string;
  locale: string;
  competitors: string[];
  modelAnswer: string;
  brandMentioned: boolean;
  citedDomains: string[];
  score: number;
  recommendations: unknown;
  createdAt: Date | string;
  mode: string;
};

type ChannelVariantRow = {
  id: string;
  contentAssetId: string;
  platform: string;
  accountId: string;
  copy: string;
  mediaAssets: string[];
  scheduledAt: Date | string | null;
  status: string;
};

function toIso(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function toDate(value: string | null | undefined) {
  return value ? new Date(value) : null;
}

function recommendations(value: unknown): GeoRecommendation[] {
  return Array.isArray(value) ? (value as GeoRecommendation[]) : [];
}

function jsonRecommendations(value: GeoRecommendation[]) {
  return value as unknown as Prisma.InputJsonValue;
}

function mapGeoRun(run: GeoRunRow): GEORun {
  return {
    id: run.id,
    projectId: run.projectId,
    contentAssetId: run.contentAssetId,
    prompt: run.prompt,
    provider: run.provider as GEORun["provider"],
    locale: run.locale,
    competitors: run.competitors,
    modelAnswer: run.modelAnswer,
    brandMentioned: run.brandMentioned,
    citedDomains: run.citedDomains,
    score: run.score,
    recommendations: recommendations(run.recommendations),
    createdAt: toIso(run.createdAt) ?? new Date().toISOString(),
    mode: run.mode as GEORun["mode"],
  };
}

function mapChannelVariant(variant: ChannelVariantRow): ChannelVariant {
  return {
    id: variant.id,
    contentAssetId: variant.contentAssetId,
    platform: variant.platform as ChannelVariant["platform"],
    accountId: variant.accountId,
    copy: variant.copy,
    mediaAssets: variant.mediaAssets,
    scheduledAt: toIso(variant.scheduledAt),
    status: variant.status as ChannelVariant["status"],
  };
}

export async function listPersistentGeoRuns(projectId: string) {
  if (!isDatabaseConfigured()) {
    return [];
  }

  const runs = await getPrisma().geoRun.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return runs.map(mapGeoRun);
}

export async function saveGeoRuns(runs: GEORun[], contentAssetId?: string | null) {
  if (!isDatabaseConfigured()) {
    addRuns(runs);
    return runs;
  }

  const prisma = getPrisma();
  const nextRuns = runs.map((run) => ({ ...run, contentAssetId: contentAssetId ?? null }));

  await prisma.$transaction(
    nextRuns.map((run) =>
      prisma.geoRun.upsert({
        where: { id: run.id },
        create: {
          id: run.id,
          projectId: run.projectId,
          contentAssetId: run.contentAssetId,
          prompt: run.prompt,
          provider: run.provider,
          locale: run.locale,
          competitors: run.competitors,
          modelAnswer: run.modelAnswer,
          brandMentioned: run.brandMentioned,
          citedDomains: run.citedDomains,
          score: run.score,
          recommendations: jsonRecommendations(run.recommendations),
          createdAt: new Date(run.createdAt),
          mode: run.mode,
        },
        update: {
          contentAssetId: run.contentAssetId,
          prompt: run.prompt,
          provider: run.provider,
          locale: run.locale,
          competitors: run.competitors,
          modelAnswer: run.modelAnswer,
          brandMentioned: run.brandMentioned,
          citedDomains: run.citedDomains,
          score: run.score,
          recommendations: jsonRecommendations(run.recommendations),
          createdAt: new Date(run.createdAt),
          mode: run.mode,
        },
      }),
    ),
  );

  if (contentAssetId) {
    const aggregate = await prisma.geoRun.aggregate({
      _avg: { score: true },
      where: { contentAssetId },
    });
    await prisma.contentAsset.update({
      where: { id: contentAssetId },
      data: { geoScore: Math.round(aggregate._avg.score ?? 0) },
    });
  }

  return nextRuns;
}

export async function listPersistentChannelVariants(contentAssetIds: string[]) {
  if (!isDatabaseConfigured()) {
    return [];
  }

  const variants = await getPrisma().channelVariant.findMany({
    where: contentAssetIds.length ? { contentAssetId: { in: contentAssetIds } } : undefined,
    orderBy: [{ scheduledAt: "desc" }, { updatedAt: "desc" }],
    take: 100,
  });
  return variants.map(mapChannelVariant);
}

export async function saveChannelVariants(variants: ChannelVariant[]) {
  if (!isDatabaseConfigured()) {
    addVariants(variants);
    return variants;
  }

  const prisma = getPrisma();
  await prisma.$transaction(
    variants.map((variant) =>
      prisma.channelVariant.upsert({
        where: { id: variant.id },
        create: {
          id: variant.id,
          contentAssetId: variant.contentAssetId,
          platform: variant.platform,
          accountId: variant.accountId,
          copy: variant.copy,
          mediaAssets: variant.mediaAssets,
          scheduledAt: toDate(variant.scheduledAt),
          status: variant.status,
        },
        update: {
          platform: variant.platform,
          accountId: variant.accountId,
          copy: variant.copy,
          mediaAssets: variant.mediaAssets,
          scheduledAt: toDate(variant.scheduledAt),
          status: variant.status,
        },
      }),
    ),
  );

  return variants;
}
