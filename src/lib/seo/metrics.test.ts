import { describe, expect, it } from "vitest";

import {
  calculateRate,
  calculateSeoMetrics,
  priority,
  SEO_FORMULA_VERSION,
  SEO_METRIC_NAMES,
  type SeoAnalysisRunInput,
  type SeoMetricName,
  type SeoOwnershipScope,
} from "./metrics";

const scope: SeoOwnershipScope = {
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: "market_1",
};

function run(
  id: string,
  observations: SeoAnalysisRunInput["observations"],
  overrides: Partial<SeoAnalysisRunInput> = {},
): SeoAnalysisRunInput {
  const firstKind = observations[0]?.kind ?? "";
  const source = firstKind.startsWith("siteone.")
    ? "siteone"
    : firstKind.startsWith("unlighthouse.")
    ? "unlighthouse"
    : firstKind.startsWith("search_console.")
    ? "search-console"
    : ["page_view", "organic_visit", "conversion"].includes(firstKind)
    ? "matomo"
    : "test";
  return {
    id,
    ...scope,
    source,
    status: "succeeded",
    startedAt: "2026-07-01T00:00:00.000Z",
    finishedAt: "2026-07-01T00:10:00.000Z",
    observations,
    ...overrides,
  };
}

function observation(
  id: string,
  kind: string,
  subject: string,
  value: unknown,
  observedAt = "2026-07-01T00:10:00.000Z",
) {
  return { id, kind, subject, value, observedAt };
}

function metric(
  metrics: ReturnType<typeof calculateSeoMetrics>,
  name: SeoMetricName,
) {
  const found = metrics.find((candidate) => candidate.name === name);
  expect(found, `missing metric ${name}`).toBeDefined();
  return found!;
}

describe("SEO formula primitives", () => {
  it("keeps the approved formula version and exact arithmetic", () => {
    expect(SEO_FORMULA_VERSION).toBe("seo-v1");
    expect(calculateRate(92, 100)).toBe(0.92);
    expect(calculateRate(0, 0)).toBeNull();
    expect(priority({
      businessValue: 5,
      expectedImpact: 4,
      confidence: 3,
      estimatedEffort: 2,
    })).toBe(30);
  });

  it.each([
    [Number.NaN, 10],
    [1, Number.POSITIVE_INFINITY],
    [-1, 10],
    [1, -10],
    [11, 10],
    [1, 0],
  ])("rejects invalid percentage operands %s/%s", (numerator, denominator) => {
    expect(calculateRate(numerator, denominator)).toBeNull();
  });

  it("rejects invalid or non-finite priority inputs", () => {
    expect(priority({
      businessValue: 6,
      expectedImpact: 4,
      confidence: 3,
      estimatedEffort: 2,
    })).toBeNull();
    expect(priority({
      businessValue: 5,
      expectedImpact: 4,
      confidence: Number.NaN,
      estimatedEffort: 2,
    })).toBeNull();
    expect(priority({
      businessValue: 5,
      expectedImpact: 4,
      confidence: 3,
      estimatedEffort: 0,
    })).toBeNull();
  });
});

describe("calculateSeoMetrics", () => {
  it("calculates every approved metric family with traceable dimensions", () => {
    const metrics = calculateSeoMetrics({
      scope,
      runs: [run("run_siteone", [
        observation("http_ok", "siteone.http_status", "https://example.test/a", { statusCode: 200 }),
        observation("http_bad", "siteone.http_status", "https://example.test/b", { statusCode: 500 }),
        observation("index_yes", "siteone.indexability", "https://example.test/a", { indexable: true }),
        observation("index_no", "siteone.indexability", "https://example.test/b", { indexable: false }),
        observation("canonical", "siteone.canonical_mismatch", "https://example.test/", { count: 1 }),
        observation("title_yes", "siteone.title", "https://example.test/a", { text: "A title" }),
        observation("title_no", "siteone.title", "https://example.test/b", { text: "  " }),
        observation("heading_yes", "siteone.heading", "https://example.test/a", { count: 1, errorCount: 0 }),
        observation("heading_no", "siteone.heading", "https://example.test/b", { count: 2, errorCount: 1 }),
        observation("schema", "siteone.structured_data", "https://example.test/a", { count: 1, types: ["Article"] }),
        observation("broken", "siteone.broken_link", "https://example.test/missing", {
          sourceUrl: "https://example.test/a",
          statusCode: 404,
        }),
      ]), run("run_lighthouse", [
        observation("perf_a", "unlighthouse.performance", "https://example.test/a", { score: 0.8 }),
        observation("perf_b", "unlighthouse.performance", "https://example.test/b", { score: 1 }),
        observation("access_a", "unlighthouse.accessibility", "https://example.test/a", { score: 0.7 }),
        observation("best_a", "unlighthouse.best_practices", "https://example.test/a", { score: 0.6 }),
        observation("seo_a", "unlighthouse.seo", "https://example.test/a", { score: 0.9 }),
        observation("lcp_a", "unlighthouse.lcp", "https://example.test/a", { milliseconds: 2_500 }),
        observation("cls_a", "unlighthouse.cls", "https://example.test/a", { score: 0.1 }),
        observation("inp_a", "unlighthouse.inp", "https://example.test/a", {
          milliseconds: 180,
          metric: "interaction-to-next-paint",
          fallback: false,
        }),
      ]), run("run_search", [
        observation("search_a", "search_console.search_analytics", "https://example.test/a", {
          date: "2026-07-01",
          query: "alpha",
          page: "https://example.test/a",
          country: "usa",
          device: "desktop",
          clicks: 10,
          impressions: 100,
          ctr: 0.1,
          position: 2,
          dataState: "final",
          scope: "top_rows",
          pagination: { truncated: false },
        }),
        observation("search_b", "search_console.search_analytics", "https://example.test/b", {
          date: "2026-07-02",
          query: "beta",
          page: "https://example.test/b",
          country: "gbr",
          device: "mobile",
          clicks: 5,
          impressions: 50,
          ctr: 0.1,
          position: 4,
          dataState: "final",
          scope: "top_rows",
          pagination: { truncated: false },
        }),
      ]), run("run_matomo", [
        observation("organic", "organic_visit", "/a", {
          count: 20,
          startDate: "2026-07-01",
          endDate: "2026-07-02",
          idSite: 1,
          segment: "referrerType==search",
          timezone: "UTC",
          reportMethod: "Actions.getPageUrls",
          metric: "nb_visits",
        }),
        observation("conversion", "conversion", "lead", {
          count: 2,
          startDate: "2026-07-01",
          endDate: "2026-07-02",
          idSite: 1,
          idGoal: 2,
          segment: "",
          timezone: "UTC",
          reportMethod: "Goals.get",
        }),
      ])],
    });

    expect(metric(metrics, SEO_METRIC_NAMES.CRAWL_SUCCESS_RATE).value).toBe(0.5);
    expect(metric(metrics, SEO_METRIC_NAMES.INDEXABILITY_RATE).value).toBe(0.5);
    expect(metric(metrics, SEO_METRIC_NAMES.CANONICAL_HEALTH_RATE).value).toBe(0.5);
    expect(metric(metrics, SEO_METRIC_NAMES.TITLE_COMPLETENESS_RATE).value).toBe(0.5);
    expect(metric(metrics, SEO_METRIC_NAMES.HEADING_COMPLETENESS_RATE).value).toBe(0.5);
    expect(metric(metrics, SEO_METRIC_NAMES.STRUCTURED_DATA_COVERAGE_RATE).value).toBe(0.5);
    expect(metric(metrics, SEO_METRIC_NAMES.BROKEN_LINK_RATE).value).toBe(0.5);
    expect(metric(metrics, SEO_METRIC_NAMES.LIGHTHOUSE_PERFORMANCE_SCORE).value).toBe(0.9);
    expect(metric(metrics, SEO_METRIC_NAMES.LIGHTHOUSE_ACCESSIBILITY_SCORE).value).toBe(0.7);
    expect(metric(metrics, SEO_METRIC_NAMES.LIGHTHOUSE_BEST_PRACTICES_SCORE).value).toBe(0.6);
    expect(metric(metrics, SEO_METRIC_NAMES.LIGHTHOUSE_SEO_SCORE).value).toBe(0.9);
    expect(metric(metrics, SEO_METRIC_NAMES.LIGHTHOUSE_LCP_MS).value).toBe(2_500);
    expect(metric(metrics, SEO_METRIC_NAMES.LIGHTHOUSE_CLS_SCORE).value).toBe(0.1);
    expect(metric(metrics, SEO_METRIC_NAMES.LIGHTHOUSE_INP_MS).value).toBe(180);
    expect(metric(metrics, SEO_METRIC_NAMES.SEARCH_CONSOLE_CLICKS).value).toBe(15);
    expect(metric(metrics, SEO_METRIC_NAMES.SEARCH_CONSOLE_IMPRESSIONS).value).toBe(150);
    expect(metric(metrics, SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR).value).toBe(0.1);
    expect(metric(metrics, SEO_METRIC_NAMES.SEARCH_CONSOLE_AVERAGE_POSITION).value)
      .toBeCloseTo(8 / 3, 8);
    expect(metric(metrics, SEO_METRIC_NAMES.ORGANIC_VISITS).value).toBe(20);
    expect(metric(metrics, SEO_METRIC_NAMES.CONVERSIONS).value).toBe(2);

    const searchCtr = metric(metrics, SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR);
    expect(searchCtr.formulaVersion).toBe(SEO_FORMULA_VERSION);
    expect(searchCtr.evidenceObservationIds).toEqual(["search_a", "search_b"]);
    expect(searchCtr.dimensions).toMatchObject({
      scope,
      definition: "sum(clicks) / sum(impressions)",
      aggregation: "search_console_final_top_rows",
      availability: { status: "available" },
      sourceRunIds: ["run_search"],
      sourceDates: { start: "2026-07-01", end: "2026-07-02" },
    });
  });

  it("isolates exact ownership, excludes non-success runs, and deduplicates repeated semantic facts", () => {
    const older = run("run_old", [
      observation("old", "organic_visit", "/pricing", {
        count: 10,
        startDate: "2026-07-01",
        endDate: "2026-07-01",
        idSite: 1,
        segment: "referrerType==search",
        timezone: "UTC",
        reportMethod: "Actions.getPageUrls",
        metric: "nb_visits",
      }, "2026-07-02T00:00:00.000Z"),
    ]);
    const newer = run("run_new", [
      observation("new", "organic_visit", "/pricing", {
        count: 12,
        startDate: "2026-07-01",
        endDate: "2026-07-01",
        idSite: 1,
        segment: "referrerType==search",
        timezone: "UTC",
        reportMethod: "Actions.getPageUrls",
        metric: "nb_visits",
      }, "2026-07-03T00:00:00.000Z"),
      observation("new_copy", "organic_visit", "/pricing", {
        count: 12,
        startDate: "2026-07-01",
        endDate: "2026-07-01",
        idSite: 1,
        segment: "referrerType==search",
        timezone: "UTC",
        reportMethod: "Actions.getPageUrls",
        metric: "nb_visits",
      }, "2026-07-03T00:00:00.000Z"),
    ]);
    const partial = run("run_partial", [
      observation("partial", "organic_visit", "/ignored", {
        count: 999,
        startDate: "2026-07-01",
        endDate: "2026-07-01",
        idSite: 1,
        segment: "referrerType==search",
        timezone: "UTC",
        reportMethod: "Actions.getPageUrls",
        metric: "nb_visits",
      }),
    ], { status: "partial" });
    const wrongClient = run("run_wrong", [
      observation("wrong", "organic_visit", "/ignored", {
        count: 999,
        startDate: "2026-07-01",
        endDate: "2026-07-01",
        idSite: 1,
        segment: "referrerType==search",
        timezone: "UTC",
        reportMethod: "Actions.getPageUrls",
        metric: "nb_visits",
      }),
    ], { clientId: "client_2" });

    const organic = metric(calculateSeoMetrics({
      scope,
      runs: [older, newer, partial, wrongClient],
    }), SEO_METRIC_NAMES.ORGANIC_VISITS);

    expect(organic.value).toBe(12);
    expect(organic.evidenceObservationIds).toEqual(["new"]);
    expect(organic.dimensions.sourceRunIds).toEqual(["run_new"]);
    expect(organic.dimensions.dedupePolicy).toBe(
      "latest complete snapshot run; otherwise latest observedAt per source semantic key; lowest observation ID breaks ties",
    );
  });

  it("uses only the latest complete snapshot run and rejects cross-source observation kinds", () => {
    const metrics = calculateSeoMetrics({
      scope,
      runs: [
        run("crawl_old", [
          observation("old_current", "siteone.http_status", "https://example.test/current", { statusCode: 500 }),
          observation("old_stale", "siteone.http_status", "https://example.test/stale", { statusCode: 500 }),
        ], { finishedAt: "2026-07-01T00:10:00.000Z" }),
        run("crawl_new", [
          observation("new_current", "siteone.http_status", "https://example.test/current", { statusCode: 200 }),
        ], { finishedAt: "2026-07-02T00:10:00.000Z" }),
        run("wrong_source", [
          observation("injected", "organic_visit", "/injected", {
            count: 999,
            startDate: "2026-07-03",
            endDate: "2026-07-03",
            idSite: 1,
            segment: "referrerType==search",
            timezone: "UTC",
            reportMethod: "Actions.getPageUrls",
            metric: "nb_visits",
          }),
        ], { source: "siteone" }),
      ],
    });

    expect(metric(metrics, SEO_METRIC_NAMES.CRAWL_SUCCESS_RATE)).toMatchObject({
      value: 1,
      evidenceObservationIds: ["new_current"],
      dimensions: { sourceRunIds: ["crawl_new"] },
    });
    expect(metric(metrics, SEO_METRIC_NAMES.ORGANIC_VISITS).value).toBeNull();
  });

  it("marks overlapping Matomo windows unavailable instead of double counting", () => {
    const metrics = calculateSeoMetrics({
      scope,
      runs: [run("matomo_1", [
        observation("window_a", "organic_visit", "/pricing", {
          count: 10,
          startDate: "2026-07-01",
          endDate: "2026-07-10",
          idSite: 1,
          segment: "referrerType==search",
          timezone: "UTC",
          reportMethod: "Actions.getPageUrls",
          metric: "nb_visits",
        }),
        observation("window_b", "organic_visit", "/pricing", {
          count: 8,
          startDate: "2026-07-05",
          endDate: "2026-07-15",
          idSite: 1,
          segment: "referrerType==search",
          timezone: "UTC",
          reportMethod: "Actions.getPageUrls",
          metric: "nb_visits",
        }),
      ])],
    });

    expect(metric(metrics, SEO_METRIC_NAMES.ORGANIC_VISITS)).toMatchObject({
      value: null,
      dimensions: {
        availability: { status: "unavailable", reason: "overlapping_source_windows" },
      },
    });
  });

  it("returns explicit unavailable metrics for malformed or absent untrusted values", () => {
    const metrics = calculateSeoMetrics({
      scope,
      runs: [run("run_invalid", [
        observation("bad_status", "siteone.http_status", "https://example.test", { statusCode: Infinity }),
        observation("bad_index", "siteone.indexability", "https://example.test", { indexable: "true" }),
        observation("bad_search", "search_console.search_analytics", "https://example.test", {
          date: "not-a-date",
          clicks: -1,
          impressions: 0,
          position: Number.NaN,
        }),
        observation("bad_organic", "organic_visit", "/", { count: -5 }),
      ])],
    });

    for (const result of metrics) {
      expect(result.value === null || Number.isFinite(result.value)).toBe(true);
      expect(result.formulaVersion).toBe(SEO_FORMULA_VERSION);
      expect(result.dimensions.scope).toEqual(scope);
    }
    expect(metric(metrics, SEO_METRIC_NAMES.CRAWL_SUCCESS_RATE)).toMatchObject({
      value: null,
      evidenceObservationIds: [],
      dimensions: { availability: { status: "unavailable", reason: "no_valid_observations" } },
    });
    expect(metric(metrics, SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR).value).toBeNull();
    expect(metric(metrics, SEO_METRIC_NAMES.ORGANIC_VISITS).value).toBeNull();
  });

  it("does not publish an invalid canonical percentage", () => {
    const metrics = calculateSeoMetrics({
      scope,
      runs: [run("run_bad_canonical", [
        observation("http", "siteone.http_status", "https://example.test", { statusCode: 200 }),
        observation("canonical", "siteone.canonical_mismatch", "https://example.test", { count: 2 }),
      ])],
    });

    expect(metric(metrics, SEO_METRIC_NAMES.CANONICAL_HEALTH_RATE)).toMatchObject({
      value: null,
      dimensions: { availability: { status: "unavailable", reason: "invalid_percentage_inputs" } },
    });
  });
});
