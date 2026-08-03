import { describe, expect, it } from "vitest";

import { SEO_FORMULA_VERSION, SEO_METRIC_NAMES } from "./metrics";
import { toPublicSeoReport } from "./report-presenter";
import type { SeoReportDto } from "./report-queries";

const report = {
  formulaVersion: SEO_FORMULA_VERSION,
  scope: {
    clientId: "client_a",
    brandId: "brand_a",
    siteId: "site_a",
    siteMarketId: "market_a",
  },
  dateWindow: {
    startAt: "2026-07-01T00:00:00.000Z",
    endAt: "2026-07-31T23:59:59.999Z",
  },
  baseline: { runId: "run_baseline", capturedAt: "2026-07-02T01:00:00.000Z" },
  latest: { runId: "run_latest", capturedAt: "2026-07-30T01:00:00.000Z" },
  metrics: {
    technical: [],
    lighthouse: [],
    search: [{
      id: "metric_latest",
      runId: "metric_run_latest",
      name: SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR,
      value: 0.2,
      dimensions: {
        scope: {
          clientId: "client_a",
          brandId: "brand_a",
          siteId: "site_a",
          siteMarketId: "market_a",
        },
        definition: "sum(clicks) / sum(impressions)",
        aggregation: "search_console_final_top_rows",
        availability: { status: "available" },
        sourceRunIds: ["run_latest"],
        sourceDates: { start: "2026-07-01", end: "2026-07-31" },
        observedAt: {
          start: "2026-07-30T00:00:00.000Z",
          end: "2026-07-30T00:00:00.000Z",
        },
        dedupePolicy: "latest source snapshot",
        inputs: { numerator: 20, denominator: 100 },
      },
      formulaVersion: SEO_FORMULA_VERSION,
      calculatedAt: "2026-07-30T02:00:00.000Z",
    }],
    analytics: [],
  },
  comparisons: [{
    name: SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR,
    definition: "sum(clicks) / sum(impressions)",
    aggregation: "search_console_final_top_rows",
    baseline: {
      id: "metric_baseline",
      runId: "metric_run_baseline",
      value: 0.1,
      calculatedAt: "2026-07-02T02:00:00.000Z",
    },
    latest: {
      id: "metric_latest",
      runId: "metric_run_latest",
      value: 0.2,
      calculatedAt: "2026-07-30T02:00:00.000Z",
    },
    delta: 0.1,
    formulaVersion: SEO_FORMULA_VERSION,
  }],
  coverage: [{
    source: "search-console",
    runCounts: { total: 2, succeeded: 2, partial: 0, failed: 0, other: 0 },
    observedAt: {
      start: "2026-07-02T00:00:00.000Z",
      end: "2026-07-30T00:00:00.000Z",
    },
    latestRunAt: "2026-07-30T01:00:00.000Z",
    latestStatus: "succeeded",
    formulaVersion: SEO_FORMULA_VERSION,
  }],
  runHistory: [{
    id: "run_latest",
    source: "search-console",
    kind: "search_console_sync",
    status: "succeeded",
    capturedAt: "2026-07-30T01:00:00.000Z",
    startedAt: "2026-07-30T00:00:00.000Z",
    finishedAt: "2026-07-30T01:00:00.000Z",
  }],
  recommendations: [{
    id: "recommendation_1",
    runId: "run_latest",
    title: "Improve pricing page",
    detail: "Use the observed demand evidence.",
    priority: 30,
    formulaVersion: SEO_FORMULA_VERSION,
    state: "open",
    ownerId: "operator_a",
    dueAt: "2026-08-10T00:00:00.000Z",
    evidenceObservationIds: ["observation_1", "observation_2"],
    createdAt: "2026-07-30T01:00:00.000Z",
    updatedAt: "2026-07-30T01:00:00.000Z",
  }],
  opportunities: [{
    id: "opportunity_1",
    title: "Pricing demand",
    state: "open",
    priority: 30,
    formulaVersion: SEO_FORMULA_VERSION,
    recommendationIds: ["recommendation_1"],
    createdAt: "2026-07-30T01:00:00.000Z",
    updatedAt: "2026-07-30T01:00:00.000Z",
  }],
  isEmpty: false,
} satisfies SeoReportDto;

describe("toPublicSeoReport", () => {
  it("maps deterministic anchors and compatible metric comparisons", () => {
    const result = toPublicSeoReport(report, {
      from: "2026-07-01",
      to: "2026-07-31",
    });

    expect(result).toMatchObject({
      siteId: "site_a",
      siteMarketId: "market_a",
      range: { from: "2026-07-01", to: "2026-07-31" },
      baseline: report.baseline,
      latest: report.latest,
      anchorPolicy: "eligible-source-runs-by-finished-at",
      metrics: [{
        name: SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR,
        value: 0.2,
        baselineValue: 0.1,
        delta: 0.1,
        family: "search",
        comparisonStatus: "compared",
        sourceRunIds: ["run_latest"],
      }],
      coverage: [{
        source: "search-console",
        status: "succeeded",
        lastRunAt: "2026-07-30T01:00:00.000Z",
      }],
      opportunities: [{
        id: "recommendation_1",
        ownerId: "operator_a",
        evidenceCount: 2,
        evidenceObservationIds: ["observation_1", "observation_2"],
        opportunityIds: ["opportunity_1"],
        groups: [{
          id: "opportunity_1",
          title: "Pricing demand",
          state: "open",
          priority: 30,
        }],
      }],
    });
    expect(JSON.stringify(result)).not.toMatch(/artifact|secret|token|inputs/i);
  });

  it("returns stable null anchors and empty rows for an empty report", () => {
    const result = toPublicSeoReport({
      ...report,
      baseline: null,
      latest: null,
      metrics: { technical: [], lighthouse: [], search: [], analytics: [] },
      comparisons: [],
      runHistory: [],
      recommendations: [],
      opportunities: [],
      isEmpty: true,
    }, { from: "2026-07-01", to: "2026-07-31" });

    expect(result).toMatchObject({
      baseline: null,
      latest: null,
      metrics: [],
      runs: [],
      opportunities: [],
      isEmpty: true,
    });
  });

  it("does not expose a baseline value when availability prevents comparison", () => {
    const result = toPublicSeoReport({
      ...report,
      comparisons: [{
        ...report.comparisons[0],
        delta: null,
      }],
    }, { from: "2026-07-01", to: "2026-07-31" });

    expect(result.metrics[0]).toMatchObject({
      value: 0.2,
      baselineValue: null,
      delta: null,
      comparisonStatus: "not_comparable",
    });
  });
});
