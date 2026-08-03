import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import {
  assertClientAccess,
  type AccessScope,
} from "@/lib/authorization";
import { getPrisma } from "@/lib/prisma";
import {
  SEO_FORMULA_VERSION,
  SEO_METRIC_NAMES,
  type SeoMetricDimensions,
  type SeoMetricName,
  type SeoOwnershipScope,
} from "./metrics";

export const SEO_REPORT_MAX_RANGE_DAYS = 366;
const maxRangeMilliseconds = SEO_REPORT_MAX_RANGE_DAYS * 24 * 60 * 60 * 1_000;

export type SeoMetricFamily =
  | "technical"
  | "lighthouse"
  | "search"
  | "analytics";

export interface SeoReportMetricDto {
  id: string;
  runId: string;
  name: SeoMetricName;
  value: number;
  dimensions: SeoMetricDimensions;
  formulaVersion: typeof SEO_FORMULA_VERSION;
  calculatedAt: string;
}

export interface SeoReportRecommendationDto {
  id: string;
  runId: string;
  title: string;
  detail: string;
  priority: number;
  formulaVersion: typeof SEO_FORMULA_VERSION;
  state: string;
  ownerId: string | null;
  dueAt: string | null;
  evidenceObservationIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SeoReportOpportunityDto {
  id: string;
  title: string;
  state: string;
  priority: number;
  formulaVersion: typeof SEO_FORMULA_VERSION;
  recommendationIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SeoReportDto {
  formulaVersion: typeof SEO_FORMULA_VERSION;
  scope: SeoOwnershipScope;
  dateWindow: { startAt: string; endAt: string };
  metrics: Record<SeoMetricFamily, SeoReportMetricDto[]>;
  recommendations: SeoReportRecommendationDto[];
  opportunities: SeoReportOpportunityDto[];
}

export interface SeoReportQueryInput extends SeoOwnershipScope {
  startAt: string | Date;
  endAt: string | Date;
}

export class SeoReportQueryInputError extends Error {
  constructor() {
    super("SEO report query input is invalid.");
    this.name = "SeoReportQueryInputError";
  }
}

type SeoReportDatabase = Pick<
  PrismaClient,
  "metricSnapshot" | "recommendation" | "opportunity" | "analysisRun"
>;

const identifierSchema = z.string().trim().min(1).max(200);
const ownershipSchema = z.object({
  clientId: identifierSchema,
  brandId: identifierSchema,
  siteId: identifierSchema,
  siteMarketId: identifierSchema.nullable(),
}).strict();
const isoDateTimeStringSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => Number.isFinite(Date.parse(value)));
const dateInputSchema = z.union([
  isoDateTimeStringSchema.transform((value) => new Date(value)),
  z.date().refine((value) => Number.isFinite(value.getTime())),
]);
const requestSchema = ownershipSchema.extend({
  startAt: dateInputSchema,
  endAt: dateInputSchema,
}).strict().refine(({ startAt, endAt }) => {
  const range = endAt.getTime() - startAt.getTime();
  return range >= 0 && range <= maxRangeMilliseconds;
});

const sourceDateRangeSchema = z.object({
  start: z.string().min(1).max(64),
  end: z.string().min(1).max(64),
}).strict();
const metricDimensionsSchema = z.object({
  scope: ownershipSchema,
  definition: z.string().min(1).max(512),
  aggregation: z.string().min(1).max(128),
  availability: z.discriminatedUnion("status", [
    z.object({ status: z.literal("available") }).strict(),
    z.object({
      status: z.literal("unavailable"),
      reason: z.string().min(1).max(128),
    }).strict(),
  ]),
  sourceRunIds: z.array(identifierSchema).max(10_000),
  sourceDates: sourceDateRangeSchema.nullable(),
  observedAt: sourceDateRangeSchema.nullable(),
  dedupePolicy: z.string().min(1).max(256),
  inputs: z.record(
    z.string().min(1).max(128),
    z.union([z.number().finite(), z.string().max(256), z.boolean(), z.null()]),
  ),
}).strict();

interface MetricRow {
  id: string;
  runId: string;
  name: string;
  value: unknown;
  dimensions: unknown;
  formulaVersion: string;
  calculatedAt: Date;
}

interface RecommendationRow {
  id: string;
  runId: string;
  title: string;
  detail: string;
  priority: unknown;
  formulaVersion: string;
  state: string;
  ownerId: string | null;
  dueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  evidence: Array<{ observationId: string }>;
}

interface OpportunityRow {
  id: string;
  title: string;
  state: string;
  priority: unknown;
  formulaVersion: string;
  createdAt: Date;
  updatedAt: Date;
  recommendations: Array<{ recommendationId: string }>;
}

function boundedText(value: string, maximumLength: number) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ")
    .trim().slice(0, maximumLength);
}

function validIdentifier(value: unknown): value is string {
  return identifierSchema.safeParse(value).success;
}

function finiteDecimal(value: unknown) {
  let numeric: number;
  try {
    numeric = typeof value === "number" ? value : Number(String(value));
  } catch {
    return null;
  }
  return Number.isFinite(numeric) ? numeric : null;
}

function isoDate(value: Date | null) {
  if (value === null || !Number.isFinite(value.getTime())) return null;
  return value.toISOString();
}

function metricIdentity(name: string): {
  name: SeoMetricName;
  family: SeoMetricFamily;
} | null {
  switch (name) {
    case SEO_METRIC_NAMES.CRAWL_SUCCESS_RATE:
    case SEO_METRIC_NAMES.INDEXABILITY_RATE:
    case SEO_METRIC_NAMES.CANONICAL_HEALTH_RATE:
    case SEO_METRIC_NAMES.TITLE_COMPLETENESS_RATE:
    case SEO_METRIC_NAMES.HEADING_COMPLETENESS_RATE:
    case SEO_METRIC_NAMES.STRUCTURED_DATA_COVERAGE_RATE:
    case SEO_METRIC_NAMES.BROKEN_LINK_RATE:
      return { name, family: "technical" };
    case SEO_METRIC_NAMES.LIGHTHOUSE_PERFORMANCE_SCORE:
    case SEO_METRIC_NAMES.LIGHTHOUSE_ACCESSIBILITY_SCORE:
    case SEO_METRIC_NAMES.LIGHTHOUSE_BEST_PRACTICES_SCORE:
    case SEO_METRIC_NAMES.LIGHTHOUSE_SEO_SCORE:
    case SEO_METRIC_NAMES.LIGHTHOUSE_LCP_MS:
    case SEO_METRIC_NAMES.LIGHTHOUSE_CLS_SCORE:
    case SEO_METRIC_NAMES.LIGHTHOUSE_INP_MS:
      return { name, family: "lighthouse" };
    case SEO_METRIC_NAMES.SEARCH_CONSOLE_CLICKS:
    case SEO_METRIC_NAMES.SEARCH_CONSOLE_IMPRESSIONS:
    case SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR:
    case SEO_METRIC_NAMES.SEARCH_CONSOLE_AVERAGE_POSITION:
      return { name, family: "search" };
    case SEO_METRIC_NAMES.ORGANIC_VISITS:
    case SEO_METRIC_NAMES.CONVERSIONS:
      return { name, family: "analytics" };
    default:
      return null;
  }
}

function mapMetric(
  row: MetricRow,
  scope: SeoOwnershipScope,
  ownedSourceRunIds: ReadonlySet<string>,
): { family: SeoMetricFamily; metric: SeoReportMetricDto } | null {
  const identity = metricIdentity(row.name);
  const dimensions = metricDimensionsSchema.safeParse(row.dimensions);
  const value = finiteDecimal(row.value);
  const calculatedAt = isoDate(row.calculatedAt);
  if (
    identity === null ||
    !dimensions.success ||
    value === null ||
    calculatedAt === null ||
    row.formulaVersion !== SEO_FORMULA_VERSION ||
    !validIdentifier(row.id) ||
    !validIdentifier(row.runId) ||
    dimensions.data.sourceRunIds.length === 0 ||
    dimensions.data.sourceRunIds.some((runId) => !ownedSourceRunIds.has(runId)) ||
    dimensions.data.scope.clientId !== scope.clientId ||
    dimensions.data.scope.brandId !== scope.brandId ||
    dimensions.data.scope.siteId !== scope.siteId ||
    dimensions.data.scope.siteMarketId !== scope.siteMarketId
  ) return null;
  return {
    family: identity.family,
    metric: {
      id: row.id,
      runId: row.runId,
      name: identity.name,
      value,
      dimensions: dimensions.data,
      formulaVersion: SEO_FORMULA_VERSION,
      calculatedAt,
    },
  };
}

function mapRecommendation(row: RecommendationRow): SeoReportRecommendationDto | null {
  const priority = finiteDecimal(row.priority);
  const dueAt = isoDate(row.dueAt);
  const createdAt = isoDate(row.createdAt);
  const updatedAt = isoDate(row.updatedAt);
  const title = boundedText(row.title, 160);
  const detail = boundedText(row.detail, 512);
  const state = boundedText(row.state, 64);
  if (
    priority === null ||
    createdAt === null ||
    updatedAt === null ||
    row.formulaVersion !== SEO_FORMULA_VERSION ||
    !validIdentifier(row.id) ||
    !validIdentifier(row.runId) ||
    title.length === 0 ||
    detail.length === 0 ||
    state.length === 0 ||
    (row.ownerId !== null && !validIdentifier(row.ownerId))
  ) return null;
  return {
    id: row.id,
    runId: row.runId,
    title,
    detail,
    priority,
    formulaVersion: SEO_FORMULA_VERSION,
    state,
    ownerId: row.ownerId,
    dueAt,
    evidenceObservationIds: [...new Set(
      row.evidence.map(({ observationId }) => observationId).filter(validIdentifier),
    )].sort(),
    createdAt,
    updatedAt,
  };
}

function mapOpportunity(row: OpportunityRow): SeoReportOpportunityDto | null {
  const priority = finiteDecimal(row.priority);
  const createdAt = isoDate(row.createdAt);
  const updatedAt = isoDate(row.updatedAt);
  const title = boundedText(row.title, 160);
  const state = boundedText(row.state, 64);
  if (
    priority === null ||
    createdAt === null ||
    updatedAt === null ||
    row.formulaVersion !== SEO_FORMULA_VERSION ||
    !validIdentifier(row.id) ||
    title.length === 0 ||
    state.length === 0
  ) return null;
  return {
    id: row.id,
    title,
    state,
    priority,
    formulaVersion: SEO_FORMULA_VERSION,
    recommendationIds: [...new Set(
      row.recommendations.map(({ recommendationId }) => recommendationId)
        .filter(validIdentifier),
    )].sort(),
    createdAt,
    updatedAt,
  };
}

function uniqueById<T extends { id: string }>(items: readonly T[]) {
  const unique = new Map<string, T>();
  for (const item of items) {
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  return [...unique.values()];
}

export class SeoReportQueries {
  constructor(private readonly database: SeoReportDatabase = getPrisma()) {}

  async getReport(access: AccessScope, value: unknown): Promise<SeoReportDto> {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) throw new SeoReportQueryInputError();
    assertClientAccess(access, parsed.data.clientId);

    const scope: SeoOwnershipScope = {
      clientId: parsed.data.clientId,
      brandId: parsed.data.brandId,
      siteId: parsed.data.siteId,
      siteMarketId: parsed.data.siteMarketId,
    };
    const dateRange = { gte: parsed.data.startAt, lte: parsed.data.endAt };
    const runWhere = {
      ...scope,
      status: "succeeded" as const,
    };
    const recommendationWhere = {
      clientId: scope.clientId,
      siteId: scope.siteId,
      formulaVersion: SEO_FORMULA_VERSION,
      run: runWhere,
    };

    const [metricRows, recommendationRows, opportunityRows] = await Promise.all([
      this.database.metricSnapshot.findMany({
        where: {
          formulaVersion: SEO_FORMULA_VERSION,
          calculatedAt: dateRange,
          run: runWhere,
        },
        select: {
          id: true,
          runId: true,
          name: true,
          value: true,
          dimensions: true,
          formulaVersion: true,
          calculatedAt: true,
        },
        orderBy: [{ name: "asc" }, { calculatedAt: "desc" }, { id: "asc" }],
      }),
      this.database.recommendation.findMany({
        where: {
          ...recommendationWhere,
          createdAt: dateRange,
        },
        select: {
          id: true,
          runId: true,
          title: true,
          detail: true,
          priority: true,
          formulaVersion: true,
          state: true,
          ownerId: true,
          dueAt: true,
          createdAt: true,
          updatedAt: true,
          evidence: {
            where: { observation: { run: runWhere } },
            select: { observationId: true },
            orderBy: { observationId: "asc" },
          },
        },
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      }),
      this.database.opportunity.findMany({
        where: {
          clientId: scope.clientId,
          siteId: scope.siteId,
          formulaVersion: SEO_FORMULA_VERSION,
          createdAt: dateRange,
          recommendations: {
            some: { recommendation: recommendationWhere },
          },
        },
        select: {
          id: true,
          title: true,
          state: true,
          priority: true,
          formulaVersion: true,
          createdAt: true,
          updatedAt: true,
          recommendations: {
            where: { recommendation: recommendationWhere },
            select: { recommendationId: true },
            orderBy: { recommendationId: "asc" },
          },
        },
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      }),
    ]);

    const candidateSourceRunIds = [...new Set(metricRows.flatMap((row) => {
      const dimensions = metricDimensionsSchema.safeParse(row.dimensions);
      return dimensions.success
        ? dimensions.data.sourceRunIds.filter(validIdentifier)
        : [];
    }))].sort();
    const ownedSourceRuns = candidateSourceRunIds.length === 0
      ? []
      : await this.database.analysisRun.findMany({
          where: {
            id: { in: candidateSourceRunIds },
            ...runWhere,
          },
          select: { id: true },
          orderBy: { id: "asc" },
        });
    const ownedSourceRunIds = new Set(ownedSourceRuns.map(({ id }) => id));

    const metrics: Record<SeoMetricFamily, SeoReportMetricDto[]> = {
      technical: [],
      lighthouse: [],
      search: [],
      analytics: [],
    };
    for (const row of metricRows) {
      const mapped = mapMetric(row, scope, ownedSourceRunIds);
      if (mapped !== null) metrics[mapped.family].push(mapped.metric);
    }
    for (const values of Object.values(metrics)) {
      values.sort((left, right) =>
        left.name.localeCompare(right.name) ||
        right.calculatedAt.localeCompare(left.calculatedAt) ||
        left.id.localeCompare(right.id)
      );
    }

    const recommendations = uniqueById(
      recommendationRows.map(mapRecommendation).filter((item) => item !== null),
    ).sort((left, right) =>
      right.priority - left.priority ||
      right.createdAt.localeCompare(left.createdAt) ||
      left.id.localeCompare(right.id)
    );
    const opportunities = uniqueById(
      opportunityRows.map(mapOpportunity).filter((item) => item !== null),
    ).sort((left, right) =>
      right.priority - left.priority ||
      right.createdAt.localeCompare(left.createdAt) ||
      left.id.localeCompare(right.id)
    );

    return {
      formulaVersion: SEO_FORMULA_VERSION,
      scope,
      dateWindow: {
        startAt: parsed.data.startAt.toISOString(),
        endAt: parsed.data.endAt.toISOString(),
      },
      metrics,
      recommendations,
      opportunities,
    };
  }
}
