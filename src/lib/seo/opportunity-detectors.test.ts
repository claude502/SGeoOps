import { describe, expect, it } from "vitest";

import {
  detectSeoRecommendations,
  normalizeSeoSubject,
  type SeoRecommendationKind,
} from "./opportunity-detectors";
import {
  SEO_FORMULA_VERSION,
  type SeoAnalysisRunInput,
  type SeoOwnershipScope,
} from "./metrics";

const scope: SeoOwnershipScope = {
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: null,
};

function observation(id: string, kind: string, subject: string, value: unknown) {
  return { id, kind, subject, value, observedAt: "2026-07-01T00:10:00.000Z" };
}

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

function ofKind(
  recommendations: ReturnType<typeof detectSeoRecommendations>,
  kind: SeoRecommendationKind,
) {
  return recommendations.filter((recommendation) => recommendation.kind === kind);
}

describe("normalizeSeoSubject", () => {
  it("normalizes same-site URL paths without retaining URL authority syntax", () => {
    expect(normalizeSeoSubject("https://example.test/pricing/")).toBe("/pricing");
    expect(normalizeSeoSubject("/pricing//")).toBe("/pricing");
    expect(normalizeSeoSubject("https://example.test/?b=2&a=1")).toBe("/?a=1&b=2");
  });

  it.each([
    "javascript:alert(1)",
    "https://user:secret@example.test/private",
    "https://example.test/%0Aadmin",
    "\u0000hidden",
    "safe\u202Efdp.exe",
    "safe\u200Fhidden",
    "https://example.test/safe\u202Efdp.exe",
    "https://example.test/safe%E2%80%AEfdp.exe",
    "https://example.test/?query=safe%E2%80%AEfdp.exe",
    "   ",
  ])("rejects URL control syntax or unsafe subject %j", (subject) => {
    expect(normalizeSeoSubject(subject)).toBeNull();
  });
});

describe("detectSeoRecommendations", () => {
  it("emits all four traceable recommendation kinds from explicit evidence", () => {
    const recommendations = detectSeoRecommendations({
      scope,
      runs: [run("run_siteone", [
        observation("technical", "siteone.http_status", "https://example.test/broken", { statusCode: 500 }),
      ]), run("run_search", [
        observation("search_summary", "search_console.sync_summary", "search-console", {
          startDate: "2026-07-01",
          endDate: "2026-07-01",
          property: "sc-domain:example.test",
          scope: "top_rows",
          dataState: "final",
          rowsFetched: 2,
          rowsIncluded: 2,
          pagination: { truncated: false },
        }),
        observation("improve", "search_console.search_analytics", "https://example.test/pricing", {
          date: "2026-07-01",
          query: "pricing",
          page: "https://example.test/pricing",
          country: "usa",
          device: "desktop",
          clicks: 1,
          impressions: 100,
          ctr: 0.01,
          position: 6,
          dataState: "final",
          scope: "top_rows",
          pagination: { truncated: false },
        }),
        observation("content", "search_console.search_analytics", "https://example.test/guide", {
          date: "2026-07-01",
          query: "advanced guide",
          page: "https://example.test/guide",
          country: "usa",
          device: "mobile",
          clicks: 0,
          impressions: 150,
          ctr: 0,
          position: 18,
          dataState: "final",
          scope: "top_rows",
          pagination: { truncated: false },
        }),
      ]), run("run_partial", [
        observation("measurement", "search_console.sync_summary", "search-console", {
          startDate: "2026-07-02",
          endDate: "2026-07-02",
          property: "sc-domain:example.test",
          scope: "top_rows",
          dataState: "final",
          rowsFetched: 25_000,
          rowsIncluded: 10_000,
          pagination: { rowLimit: 25_000, pagesFetched: 1, truncated: true },
        }),
      ], { status: "partial" })],
    });

    expect(recommendations.map(({ kind }) => kind)).toEqual([
      "technical_fix",
      "existing_page_improvement",
      "new_content",
      "measurement_repair",
    ]);
    expect(ofKind(recommendations, "technical_fix")[0]).toMatchObject({
      siteId: scope.siteId,
      subject: "/broken",
      observationIds: ["technical"],
      formulaVersion: SEO_FORMULA_VERSION,
      priorityInputs: {
        businessValue: 5,
        expectedImpact: 5,
        confidence: 4,
        estimatedEffort: 2,
      },
      calculatedPriority: 50,
      operatorOverride: null,
    });
    expect(ofKind(recommendations, "new_content")[0]).toMatchObject({
      subject: "query:advanced guide",
      observationIds: ["content"],
    });
    expect(ofKind(recommendations, "measurement_repair")[0].observationIds)
      .toEqual(["measurement"]);
  });

  it("does not emit an issue from an unfinished source snapshot", () => {
    const recommendations = detectSeoRecommendations({
      scope,
      runs: [run("unfinished", [
        observation("unfinished_issue", "siteone.http_status", "https://example.test/broken", { statusCode: 500 }),
      ], {
        finishedAt: null,
        startedAt: "2026-07-03T00:00:00.000Z",
      })],
    });

    expect(recommendations).toEqual([]);
  });

  it("groups by normalized subject and kind with stable evidence and output order", () => {
    const input = {
      scope,
      runs: [run("run_1", [
        observation("z_status", "siteone.http_status", "https://example.test/pricing/", { statusCode: 404 }),
        observation("a_index", "siteone.indexability", "/pricing", { indexable: false }),
        observation("a_index", "siteone.indexability", "/pricing", { indexable: false }),
        observation("other", "siteone.http_status", "https://example.test/about", { statusCode: 500 }),
      ])],
    };

    const first = detectSeoRecommendations(input);
    const second = detectSeoRecommendations({ ...input, runs: [...input.runs].reverse() });

    expect(first).toEqual(second);
    expect(ofKind(first, "technical_fix").map(({ subject }) => subject)).toEqual([
      "/about",
      "/pricing",
    ]);
    expect(ofKind(first, "technical_fix")[1].observationIds).toEqual([
      "a_index",
      "z_status",
    ]);
    expect(ofKind(first, "technical_fix")).toHaveLength(2);
  });

  it("keeps a validated operator override separate from calculated priority", () => {
    const recommendations = detectSeoRecommendations({
      scope,
      runs: [run("run_1", [
        observation("broken", "siteone.broken_link", "https://example.test/missing", {
          sourceUrl: "https://example.test/pricing",
          statusCode: 404,
        }),
      ])],
      operatorOverrides: [{
        siteId: scope.siteId,
        kind: "technical_fix",
        subject: "/missing/",
        value: 7.5,
      }, {
        siteId: "site_2",
        kind: "technical_fix",
        subject: "/missing",
        value: 99,
      }],
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      calculatedPriority: 50,
      operatorOverride: 7.5,
    });
    expect(recommendations[0].priorityInputs).toEqual({
      businessValue: 5,
      expectedImpact: 5,
      confidence: 4,
      estimatedEffort: 2,
    });
  });

  it("does not recommend an issue that disappeared from the latest complete snapshot", () => {
    const recommendations = detectSeoRecommendations({
      scope,
      runs: [
        run("crawl_old", [
          observation("old_error", "siteone.http_status", "https://example.test/pricing", { statusCode: 500 }),
        ], { finishedAt: "2026-07-01T00:10:00.000Z" }),
        run("crawl_new", [
          observation("new_ok", "siteone.http_status", "https://example.test/pricing", { statusCode: 200 }),
        ], { finishedAt: "2026-07-02T00:10:00.000Z" }),
      ],
    });

    expect(recommendations).toEqual([]);
  });

  it("suppresses a stale high-demand query when a newer successful Search Console snapshot is empty", () => {
    const recommendations = detectSeoRecommendations({
      scope,
      runs: [
        run("search_old", [
          observation("old_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            property: "sc-domain:example.test",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 1,
            rowsIncluded: 1,
            pagination: { truncated: false },
          }),
          observation("old_query", "search_console.search_analytics", "/guides", {
            date: "2026-07-01",
            query: "stale demand",
            page: "https://example.test/guides",
            country: "usa",
            device: "desktop",
            clicks: 0,
            impressions: 150,
            ctr: 0,
            position: 18,
            dataState: "final",
            scope: "top_rows",
            pagination: { truncated: false },
          }),
        ], { finishedAt: "2026-07-02T00:00:00.000Z" }),
        run("search_new_empty", [
          observation("new_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            property: "sc-domain:example.test",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 0,
            rowsIncluded: 0,
            pagination: { truncated: false },
          }),
        ], { finishedAt: "2026-07-03T00:00:00.000Z" }),
      ],
    });

    expect(recommendations).toEqual([]);
  });

  it("suppresses a stale partial measurement repair when a newer Search Console snapshot is complete", () => {
    const recommendations = detectSeoRecommendations({
      scope,
      runs: [
        run("search_partial", [
          observation("partial_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            property: "sc-domain:example.test",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 25_000,
            rowsIncluded: 10_000,
            pagination: { truncated: true },
          }),
        ], {
          status: "partial",
          finishedAt: "2026-07-02T00:00:00.000Z",
        }),
        run("search_complete", [
          observation("complete_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            property: "sc-domain:example.test",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 0,
            rowsIncluded: 0,
            pagination: { truncated: false },
          }),
        ], { finishedAt: "2026-07-03T00:00:00.000Z" }),
      ],
    });

    expect(recommendations).toEqual([]);
  });

  it("does not let a whitespace-padded property replace a canonical Search Console snapshot", () => {
    const recommendations = detectSeoRecommendations({
      scope,
      runs: [
        run("canonical_snapshot", [
          observation("canonical_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            property: "sc-domain:example.test",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 1,
            rowsIncluded: 1,
            pagination: { truncated: false },
          }),
          observation("canonical_query", "search_console.search_analytics", "/guides", {
            date: "2026-07-01",
            query: "canonical demand",
            page: "https://example.test/guides",
            country: "usa",
            device: "desktop",
            clicks: 0,
            impressions: 150,
            ctr: 0,
            position: 18,
            dataState: "final",
            scope: "top_rows",
            pagination: { truncated: false },
          }),
        ], { finishedAt: "2026-07-02T00:00:00.000Z" }),
        run("padded_empty_snapshot", [
          observation("padded_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            property: " sc-domain:example.test ",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 0,
            rowsIncluded: 0,
            pagination: { truncated: false },
          }),
        ], { finishedAt: "2026-07-03T00:00:00.000Z" }),
      ],
    });

    expect(recommendations).toMatchObject([{
      kind: "new_content",
      subject: "query:canonical demand",
      observationIds: ["canonical_query"],
    }]);
  });

  it("rejects forged Search Console properties before they can draft content or measurement repairs", () => {
    const recommendations = detectSeoRecommendations({
      scope,
      runs: [
        run("forged_query_snapshot", [
          observation("forged_query_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            property: "ftp://example.test/",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 1,
            rowsIncluded: 1,
            pagination: { truncated: false },
          }),
          observation("forged_query", "search_console.search_analytics", "/guides", {
            date: "2026-07-01",
            query: "forged demand",
            page: "https://example.test/guides",
            country: "usa",
            device: "desktop",
            clicks: 0,
            impressions: 150,
            ctr: 0,
            position: 18,
            dataState: "final",
            scope: "top_rows",
            pagination: { truncated: false },
          }),
        ]),
        run("forged_measurement_snapshot", [
          observation("forged_measurement_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            property: "https://example.test/?forged=true",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 25_000,
            rowsIncluded: 10_000,
            pagination: { truncated: true },
          }),
        ], { status: "partial" }),
      ],
    });

    expect(recommendations).toEqual([]);
  });

  it("accepts canonical URL-prefix and sc-domain Search Console properties", () => {
    const recommendations = detectSeoRecommendations({
      scope,
      runs: [
        run("domain_property", [
          observation("domain_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            property: "sc-domain:example.test",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 1,
            rowsIncluded: 1,
            pagination: { truncated: false },
          }),
          observation("domain_query", "search_console.search_analytics", "/domain", {
            date: "2026-07-01",
            query: "domain demand",
            page: "https://example.test/domain",
            country: "usa",
            device: "desktop",
            clicks: 0,
            impressions: 150,
            ctr: 0,
            position: 18,
            dataState: "final",
            scope: "top_rows",
            pagination: { truncated: false },
          }),
        ]),
        run("url_property", [
          observation("url_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            property: "https://shop.example.test/",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 1,
            rowsIncluded: 1,
            pagination: { truncated: false },
          }),
          observation("url_query", "search_console.search_analytics", "/shop", {
            date: "2026-07-01",
            query: "url demand",
            page: "https://shop.example.test/shop",
            country: "usa",
            device: "desktop",
            clicks: 0,
            impressions: 150,
            ctr: 0,
            position: 18,
            dataState: "final",
            scope: "top_rows",
            pagination: { truncated: false },
          }),
        ]),
      ],
    });

    expect(recommendations.map(({ subject }) => subject)).toEqual([
      "query:domain demand",
      "query:url demand",
    ]);
  });

  it("keeps independent Search Console windows and rejects facts without a trusted snapshot summary", () => {
    const recommendations = detectSeoRecommendations({
      scope,
      runs: [
        run("search_window_one", [
          observation("window_one_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            property: "sc-domain:example.test",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 1,
            rowsIncluded: 1,
            pagination: { truncated: false },
          }),
          observation("window_one_query", "search_console.search_analytics", "/guides", {
            date: "2026-07-01",
            query: "still relevant",
            page: "https://example.test/guides",
            country: "usa",
            device: "desktop",
            clicks: 0,
            impressions: 150,
            ctr: 0,
            position: 18,
            dataState: "final",
            scope: "top_rows",
            pagination: { truncated: false },
          }),
        ], { finishedAt: "2026-07-02T00:00:00.000Z" }),
        run("search_other_window_empty", [
          observation("other_window_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-02",
            endDate: "2026-07-02",
            property: "sc-domain:example.test",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 0,
            rowsIncluded: 0,
            pagination: { truncated: false },
          }),
        ], { finishedAt: "2026-07-03T00:00:00.000Z" }),
        run("search_other_property_empty", [
          observation("other_property_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            property: "sc-domain:other.test",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 0,
            rowsIncluded: 0,
            pagination: { truncated: false },
          }),
        ], { finishedAt: "2026-07-03T00:00:00.000Z" }),
        run("search_without_summary", [
          observation("untrusted_query", "search_console.search_analytics", "/ignored", {
            date: "2026-07-01",
            query: "must not be emitted",
            page: "https://example.test/ignored",
            country: "usa",
            device: "desktop",
            clicks: 0,
            impressions: 150,
            ctr: 0,
            position: 18,
            dataState: "final",
            scope: "top_rows",
            pagination: { truncated: false },
          }),
        ], { finishedAt: "2026-07-04T00:00:00.000Z" }),
        run("search_invalid_summary", [
          observation("invalid_summary", "search_console.sync_summary", "search-console", {
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            property: "sc-domain:unsafe\u202E.test",
            scope: "top_rows",
            dataState: "final",
            rowsFetched: 1,
            rowsIncluded: 1,
            pagination: { truncated: false },
          }),
          observation("invalid_summary_query", "search_console.search_analytics", "/invalid", {
            date: "2026-07-01",
            query: "must also not be emitted",
            page: "https://example.test/invalid",
            country: "usa",
            device: "desktop",
            clicks: 0,
            impressions: 150,
            ctr: 0,
            position: 18,
            dataState: "final",
            scope: "top_rows",
            pagination: { truncated: false },
          }),
        ], { finishedAt: "2026-07-04T00:00:00.000Z" }),
      ],
    });

    expect(recommendations).toMatchObject([{
      kind: "new_content",
      subject: "query:still relevant",
      observationIds: ["window_one_query"],
    }]);
  });

  it("ignores cross-scope, failed issue, malformed, and unsafe untrusted data", () => {
    const longInjection = `https://example.test/${"x".repeat(600)}\n<script>alert(1)</script>`;
    const recommendations = detectSeoRecommendations({
      scope,
      runs: [
        run("wrong_scope", [
          observation("wrong", "siteone.http_status", "https://example.test/wrong", { statusCode: 500 }),
        ], { clientId: "client_2" }),
        run("failed", [
          observation("failed_issue", "siteone.http_status", "https://example.test/failed", { statusCode: 500 }),
        ], { status: "failed" }),
        run("malformed", [
          observation("bad_status", "siteone.http_status", longInjection, { statusCode: "500" }),
          observation("bad_search", "search_console.search_analytics", "javascript:alert(1)", {
            clicks: -1,
            impressions: "100",
          }),
        ]),
      ],
      operatorOverrides: [{
        siteId: scope.siteId,
        kind: "technical_fix",
        subject: "/failed",
        value: Number.POSITIVE_INFINITY,
      }],
    });

    expect(recommendations).toEqual([]);
    expect(JSON.stringify(recommendations)).not.toMatch(/script|alert|javascript/i);
  });

  it("rejects Unicode direction and invisible formatting controls before rendering drafts", () => {
    const unsafeQuery = "safe\u202Efdp.exe";
    const recommendations = detectSeoRecommendations({
      scope,
      runs: [run("run_1", [
        observation("search_summary", "search_console.sync_summary", "search-console", {
          startDate: "2026-07-01",
          endDate: "2026-07-01",
          property: "sc-domain:example.test",
          scope: "top_rows",
          dataState: "final",
          rowsFetched: 1,
          rowsIncluded: 1,
          pagination: { truncated: false },
        }),
        observation("bidi_query", "search_console.search_analytics", "/ignored", {
          date: "2026-07-01",
          query: unsafeQuery,
          page: "https://example.test/ignored",
          country: "usa",
          device: "desktop",
          clicks: 0,
          impressions: 150,
          ctr: 0,
          position: 18,
          dataState: "final",
          scope: "top_rows",
          pagination: { truncated: false },
        }),
      ])],
    });

    expect(recommendations).toEqual([]);
    expect(JSON.stringify(recommendations)).not.toContain("\u202E");
  });

  it("bounds generated titles and details without echoing raw observation values", () => {
    const recommendations = detectSeoRecommendations({
      scope,
      runs: [run("run_1", [
        observation("title", "siteone.title", `/${"x".repeat(400)}`, {
          text: "   ",
          rawDetail: "\u0000SECRET<script>alert(1)</script>",
        }),
      ])],
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].title.length).toBeLessThanOrEqual(160);
    expect(recommendations[0].detail.length).toBeLessThanOrEqual(512);
    expect(`${recommendations[0].title} ${recommendations[0].detail}`)
      .not.toMatch(/secret|script|alert/i);
  });
});
