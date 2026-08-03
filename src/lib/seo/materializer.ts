import { Prisma, type PrismaClient } from "@prisma/client";

import {
  calculateSeoMetrics,
  SEO_FORMULA_VERSION,
  type SeoOwnershipScope,
} from "./metrics";
import { detectSeoRecommendations } from "./opportunity-detectors";

type MaterializerDatabase = Pick<
  PrismaClient,
  "analysisRun" | "metricSnapshot" | "recommendation" | "opportunity" | "$queryRaw"
>;

export interface SeoMaterializationInput {
  runId: string;
  scope: SeoOwnershipScope;
}

export interface SeoMaterializationResult {
  metrics: number;
  recommendations: number;
  opportunities: number;
}

function opportunityId(recommendationId: string) {
  return `${recommendationId}:opportunity`;
}

function priority(value: { calculatedPriority: number; operatorOverride: number | null }) {
  return value.operatorOverride ?? value.calculatedPriority;
}

export async function materializeSeoOutputs(
  database: MaterializerDatabase,
  input: SeoMaterializationInput,
): Promise<SeoMaterializationResult> {
  const { scope } = input;

  // Source runs for one site scope may arrive concurrently. Serialize the
  // snapshot read and write so each materialized revision is deterministic.
  await database.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        ${`${scope.clientId}\u0000${scope.brandId}\u0000${scope.siteId}\u0000${scope.siteMarketId ?? ""}`},
        7189::bigint
      )
    )
  `;

  const runs = await database.analysisRun.findMany({
    where: {
      ...scope,
      status: { in: ["succeeded", "partial"] },
      finishedAt: { not: null },
    },
    select: {
      id: true,
      clientId: true,
      brandId: true,
      siteId: true,
      siteMarketId: true,
      source: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      observations: {
        select: {
          id: true,
          kind: true,
          subject: true,
          value: true,
          observedAt: true,
        },
        orderBy: { id: "asc" },
      },
    },
    orderBy: [{ finishedAt: "asc" }, { id: "asc" }],
  });

  const metrics = calculateSeoMetrics({ scope, runs });
  const availableMetrics = metrics.filter(({ value }) => value !== null);
  if (availableMetrics.length > 0) {
    await database.metricSnapshot.createMany({
      data: availableMetrics.map((metric) => ({
        runId: input.runId,
        name: metric.name,
        value: metric.value!,
        dimensions: metric.dimensions as unknown as Prisma.InputJsonValue,
        formulaVersion: SEO_FORMULA_VERSION,
      })),
    });
  }

  const recommendations = detectSeoRecommendations({ scope, runs });
  for (const recommendation of recommendations) {
    const recommendationId = recommendation.idempotencyKey;
    const recommendationPriority = priority(recommendation);
    const evidence = recommendation.observationIds.map((observationId) => ({
      observationId,
    }));

    await database.recommendation.upsert({
      where: { id: recommendationId },
      create: {
        id: recommendationId,
        runId: input.runId,
        clientId: scope.clientId,
        siteId: scope.siteId,
        title: recommendation.title,
        detail: recommendation.detail,
        priority: recommendationPriority,
        formulaVersion: SEO_FORMULA_VERSION,
        evidence: { create: evidence },
      },
      update: {
        runId: input.runId,
        title: recommendation.title,
        detail: recommendation.detail,
        priority: recommendationPriority,
        formulaVersion: SEO_FORMULA_VERSION,
        evidence: {
          deleteMany: {},
          create: evidence,
        },
      },
    });

    await database.opportunity.upsert({
      where: { id: opportunityId(recommendationId) },
      create: {
        id: opportunityId(recommendationId),
        clientId: scope.clientId,
        siteId: scope.siteId,
        title: recommendation.title,
        priority: recommendationPriority,
        formulaVersion: SEO_FORMULA_VERSION,
        recommendations: { create: { recommendationId } },
      },
      update: {
        title: recommendation.title,
        priority: recommendationPriority,
        formulaVersion: SEO_FORMULA_VERSION,
        recommendations: {
          connectOrCreate: {
            where: {
              opportunityId_recommendationId: {
                opportunityId: opportunityId(recommendationId),
                recommendationId,
              },
            },
            create: { recommendationId },
          },
        },
      },
    });
  }

  return {
    metrics: availableMetrics.length,
    recommendations: recommendations.length,
    opportunities: recommendations.length,
  };
}
