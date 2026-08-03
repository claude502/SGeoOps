import { SEO_FORMULA_VERSION, type SeoMetricName } from "./metrics";
import type {
  SeoMetricFamily,
  SeoReportDto,
  SeoReportRunDto,
} from "./report-queries";

export interface PublicSeoMetric {
  name: SeoMetricName;
  family: SeoMetricFamily;
  value: number | null;
  baselineValue: number | null;
  delta: number | null;
  comparisonStatus: "compared" | "no_baseline" | "not_comparable" | "unavailable";
  definition: string;
  aggregation: string;
  sourceRunIds: string[];
  sourceDates: { start: string; end: string } | null;
  observedAt: { start: string; end: string } | null;
  capturedAt: string | null;
}

export interface PublicSeoCoverage {
  source: string;
  status: string;
  lastRunAt: string | null;
  runCounts: {
    total: number;
    succeeded: number;
    partial: number;
    failed: number;
    other: number;
  };
  observedAt: { start: string; end: string } | null;
}

export interface PublicSeoOpportunity {
  id: string;
  runId: string;
  title: string;
  detail: string;
  priority: number;
  state: string;
  ownerId: string | null;
  dueAt: string | null;
  evidenceCount: number;
  evidenceObservationIds: string[];
  opportunityIds: string[];
  groups: Array<{
    id: string;
    title: string;
    state: string;
    priority: number;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface PublicSeoReport {
  siteId: string;
  siteMarketId: string | null;
  range: { from: string; to: string };
  baseline: { runId: string; capturedAt: string } | null;
  latest: { runId: string; capturedAt: string } | null;
  anchorPolicy: "eligible-source-runs-by-finished-at";
  formulaVersion: typeof SEO_FORMULA_VERSION;
  metrics: PublicSeoMetric[];
  coverage: PublicSeoCoverage[];
  runs: SeoReportRunDto[];
  opportunities: PublicSeoOpportunity[];
  isEmpty: boolean;
}

function metricKey(name: string, definition: string, aggregation: string) {
  return JSON.stringify([name, definition, aggregation]);
}

export function toPublicSeoReport(
  report: SeoReportDto,
  range: { from: string; to: string },
): PublicSeoReport {
  const metricsByIdentity = new Map<string, {
    family: SeoMetricFamily;
    metric: SeoReportDto["metrics"][SeoMetricFamily][number];
  }>();
  for (const family of Object.keys(report.metrics) as SeoMetricFamily[]) {
    for (const metric of report.metrics[family]) {
      const key = metricKey(
        metric.name,
        metric.dimensions.definition,
        metric.dimensions.aggregation,
      );
      const current = metricsByIdentity.get(key);
      if (
        current === undefined ||
        metric.calculatedAt > current.metric.calculatedAt ||
        (metric.calculatedAt === current.metric.calculatedAt && metric.id < current.metric.id)
      ) {
        metricsByIdentity.set(key, { family, metric });
      }
    }
  }

  const metrics = report.comparisons.flatMap<PublicSeoMetric>((comparison) => {
    const selected = metricsByIdentity.get(metricKey(
      comparison.name,
      comparison.definition,
      comparison.aggregation,
    ));
    if (selected === undefined) return [];
    const available = selected.metric.dimensions.availability.status === "available";
    const comparable = available && comparison.baseline !== null && comparison.delta !== null;
    return [{
      name: comparison.name,
      family: selected.family,
      value: available ? comparison.latest?.value ?? null : null,
      baselineValue: comparable ? comparison.baseline?.value ?? null : null,
      delta: comparable ? comparison.delta : null,
      comparisonStatus: available
        ? comparison.baseline === null
          ? "no_baseline"
          : comparable ? "compared" : "not_comparable"
        : "unavailable",
      definition: comparison.definition,
      aggregation: comparison.aggregation,
      sourceRunIds: selected.metric.dimensions.sourceRunIds,
      sourceDates: selected.metric.dimensions.sourceDates,
      observedAt: selected.metric.dimensions.observedAt,
      capturedAt: comparison.latest?.calculatedAt ?? null,
    }];
  });

  const groupsByRecommendation = new Map<string, PublicSeoOpportunity["groups"]>();
  for (const opportunity of report.opportunities) {
    for (const recommendationId of opportunity.recommendationIds) {
      const groups = groupsByRecommendation.get(recommendationId) ?? [];
      groups.push({
        id: opportunity.id,
        title: opportunity.title,
        state: opportunity.state,
        priority: opportunity.priority,
      });
      groupsByRecommendation.set(recommendationId, groups);
    }
  }

  return {
    siteId: report.scope.siteId,
    siteMarketId: report.scope.siteMarketId,
    range,
    baseline: report.baseline,
    latest: report.latest,
    anchorPolicy: "eligible-source-runs-by-finished-at",
    formulaVersion: SEO_FORMULA_VERSION,
    metrics,
    coverage: report.coverage.map((item) => ({
      source: item.source,
      status: item.latestStatus ?? "missing",
      lastRunAt: item.latestRunAt,
      runCounts: item.runCounts,
      observedAt: item.observedAt,
    })),
    runs: report.runHistory,
    opportunities: report.recommendations.map((item) => ({
      id: item.id,
      runId: item.runId,
      title: item.title,
      detail: item.detail,
      priority: item.priority,
      state: item.state,
      ownerId: item.ownerId,
      dueAt: item.dueAt,
      evidenceCount: item.evidenceObservationIds.length,
      evidenceObservationIds: item.evidenceObservationIds,
      opportunityIds: (groupsByRecommendation.get(item.id) ?? [])
        .map(({ id }) => id)
        .sort(),
      groups: [...(groupsByRecommendation.get(item.id) ?? [])].sort((left, right) =>
        right.priority - left.priority || left.id.localeCompare(right.id)
      ),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
    isEmpty: report.isEmpty,
  };
}
