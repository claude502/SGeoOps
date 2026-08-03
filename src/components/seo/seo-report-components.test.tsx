import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OpportunityQueue } from "@/components/opportunities/opportunity-queue";
import { BaselineSummary } from "./baseline-summary";
import { ComparisonTable } from "./comparison-table";
import { RunHistory } from "./run-history";
import { SourceCoverage } from "./source-coverage";
import type { PublicSeoReport } from "@/lib/seo/report-presenter";
import { SEO_FORMULA_VERSION, SEO_METRIC_NAMES } from "@/lib/seo/metrics";

const report: PublicSeoReport = {
  siteId: "site_a",
  siteMarketId: "market_a",
  range: { from: "2026-07-01", to: "2026-07-31" },
  baseline: { runId: "run_baseline", capturedAt: "2026-07-02T01:00:00.000Z" },
  latest: { runId: "run_latest", capturedAt: "2026-07-30T01:00:00.000Z" },
  anchorPolicy: "eligible-source-runs-by-finished-at",
  formulaVersion: SEO_FORMULA_VERSION,
  metrics: [{
    name: SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR,
    family: "search",
    value: 0.2,
    baselineValue: 0.1,
    delta: 0.1,
    comparisonStatus: "compared",
    definition: "sum(clicks) / sum(impressions)",
    aggregation: "search_console_final_top_rows",
    sourceRunIds: ["run_latest"],
    sourceDates: { start: "2026-07-01", end: "2026-07-31" },
    observedAt: {
      start: "2026-07-30T00:00:00.000Z",
      end: "2026-07-30T00:00:00.000Z",
    },
    capturedAt: "2026-07-30T02:00:00.000Z",
  }],
  coverage: [{
    source: "search-console",
    status: "succeeded",
    lastRunAt: "2026-07-30T01:00:00.000Z",
    runCounts: { total: 2, succeeded: 2, partial: 0, failed: 0, other: 0 },
    observedAt: {
      start: "2026-07-02T00:00:00.000Z",
      end: "2026-07-30T00:00:00.000Z",
    },
  }, {
    source: "matomo",
    status: "missing",
    lastRunAt: null,
    runCounts: { total: 0, succeeded: 0, partial: 0, failed: 0, other: 0 },
    observedAt: null,
  }],
  runs: [{
    id: "run_latest",
    source: "search-console",
    kind: "search_console_sync",
    status: "succeeded",
    startedAt: "2026-07-30T00:00:00.000Z",
    finishedAt: "2026-07-30T01:00:00.000Z",
    capturedAt: "2026-07-30T01:00:00.000Z",
  }],
  opportunities: [{
    id: "recommendation_1",
    runId: "run_latest",
    title: "Improve pricing page",
    detail: "Use the observed demand evidence.",
    priority: 30,
    state: "open",
    ownerId: "operator_a",
    dueAt: "2026-08-10T00:00:00.000Z",
    evidenceCount: 2,
    evidenceObservationIds: ["observation_1", "observation_2"],
    opportunityIds: ["opportunity_1"],
    groups: [{
      id: "opportunity_1",
      title: "Pricing demand",
      state: "open",
      priority: 30,
    }],
    createdAt: "2026-07-30T01:00:00.000Z",
    updatedAt: "2026-07-30T01:00:00.000Z",
  }],
  isEmpty: false,
};

describe("SEO report presentation", () => {
  it("renders compact baseline and compatible metric summaries", () => {
    const markup = renderToStaticMarkup(<BaselineSummary report={report} />);

    expect(markup).toContain("Baseline");
    expect(markup).toContain("run_baseline");
    expect(markup).toContain("Latest");
    expect(markup).toContain("20.00%");
    expect(markup).toContain("+10.00%");
  });

  it("renders comparison and coverage rows as semantic tables", () => {
    const comparisons = renderToStaticMarkup(<ComparisonTable metrics={report.metrics} />);
    const coverage = renderToStaticMarkup(<SourceCoverage coverage={report.coverage} />);

    expect(comparisons).toContain("<table");
    expect(comparisons).toContain(SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR);
    expect(comparisons).toContain("search_console_final_top_rows");
    expect(coverage).toContain("<table");
    expect(coverage).toContain("search-console");
    expect(coverage).toContain("matomo");
    expect(coverage).toContain("Never");
  });

  it("keeps run and opportunity evidence/operator fields visible", () => {
    const runs = renderToStaticMarkup(<RunHistory runs={report.runs} />);
    const opportunities = renderToStaticMarkup(
      <OpportunityQueue opportunities={report.opportunities} />,
    );

    expect(runs).toContain("run_latest");
    expect(runs).toContain("search_console_sync");
    expect(opportunities).toContain("operator_a");
    expect(opportunities).toContain("Pricing demand");
    expect(opportunities).toContain("2 evidence IDs");
    expect(opportunities).toContain("observation_1");
  });

  it("renders explicit empty states without placeholder rows", () => {
    const comparisons = renderToStaticMarkup(<ComparisonTable metrics={[]} />);
    const coverage = renderToStaticMarkup(<SourceCoverage coverage={[]} />);
    const runs = renderToStaticMarkup(<RunHistory runs={[]} />);
    const opportunities = renderToStaticMarkup(<OpportunityQueue opportunities={[]} />);

    expect(comparisons).toContain("No metrics in this date range");
    expect(coverage).toContain("No source coverage in this date range");
    expect(runs).toContain("No source runs in this date range");
    expect(opportunities).toContain("No open or historical opportunities in this date range");
  });
});
