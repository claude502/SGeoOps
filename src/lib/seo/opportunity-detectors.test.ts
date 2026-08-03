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
