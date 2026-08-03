import { describe, expect, it, vi } from "vitest";

import type { AccessScope } from "@/lib/authorization";
import {
  SeoReportQueries,
  SeoReportQueryInputError,
  SeoReportScopeNotFoundError,
} from "./report-queries";
import {
  SEO_FORMULA_VERSION,
  SEO_METRIC_NAMES,
  type SeoMetricDimensions,
} from "./metrics";

const access: AccessScope = {
  actorId: "user_1",
  workspaceId: "workspace_internal",
  role: "Viewer",
  clientIds: ["client_1"],
};
const request = {
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: "market_1",
  startAt: "2026-07-01T00:00:00.000Z",
  endAt: "2026-07-31T23:59:59.999Z",
};

const dimensions: SeoMetricDimensions = {
  scope: {
    clientId: request.clientId,
    brandId: request.brandId,
    siteId: request.siteId,
    siteMarketId: request.siteMarketId,
  },
  definition: "sum(clicks) / sum(impressions)",
  aggregation: "search_console_final_top_rows",
  availability: { status: "available" },
  sourceRunIds: ["run_1"],
  sourceDates: { start: "2026-07-01", end: "2026-07-31" },
  observedAt: {
    start: "2026-07-31T01:00:00.000Z",
    end: "2026-07-31T01:00:00.000Z",
  },
  dedupePolicy: "latest observedAt per source semantic key; lowest observation ID breaks ties",
  inputs: { numerator: 92, denominator: 100 },
};

function harness() {
  const database = {
    site: {
      findFirst: vi.fn().mockResolvedValue({ id: request.siteId }),
    },
    metricSnapshot: {
      findMany: vi.fn().mockResolvedValue([{
        id: "metric_1",
        runId: "run_1",
        name: SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR,
        value: "0.92",
        dimensions,
        formulaVersion: SEO_FORMULA_VERSION,
        calculatedAt: new Date("2026-07-31T01:00:00.000Z"),
      }, {
        id: "metric_unsafe",
        runId: "run_1",
        name: SEO_METRIC_NAMES.SEARCH_CONSOLE_CLICKS,
        value: "10",
        dimensions: { token: "must-not-leak" },
        formulaVersion: SEO_FORMULA_VERSION,
        calculatedAt: new Date("2026-07-31T01:00:00.000Z"),
      }]),
    },
    recommendation: {
      findMany: vi.fn().mockResolvedValue([{
        id: "recommendation_1",
        runId: "run_1",
        title: "Improve pricing page",
        detail: "Use grouped evidence.",
        priority: "30",
        formulaVersion: SEO_FORMULA_VERSION,
        state: "open",
        ownerId: null,
        dueAt: null,
        createdAt: new Date("2026-07-30T01:00:00.000Z"),
        updatedAt: new Date("2026-07-30T01:00:00.000Z"),
        evidence: [{ observationId: "observation_2" }, { observationId: "observation_1" }],
      }]),
    },
    opportunity: {
      findMany: vi.fn().mockResolvedValue([{
        id: "opportunity_1",
        title: "Pricing demand",
        state: "open",
        priority: "30",
        formulaVersion: SEO_FORMULA_VERSION,
        createdAt: new Date("2026-07-29T01:00:00.000Z"),
        updatedAt: new Date("2026-07-29T01:00:00.000Z"),
        recommendations: [{ recommendationId: "recommendation_1" }],
      }]),
    },
    analysisRun: {
      findMany: vi.fn().mockImplementation((query: { select?: Record<string, unknown> }) => {
        if (query.select?.source === true) return Promise.resolve([]);
        return Promise.resolve([{ id: "run_1" }]);
      }),
    },
  };
  return {
    database,
    queries: new SeoReportQueries(database as never),
  };
}

describe("SeoReportQueries", () => {
  it("pushes exact ownership, status, formula, and date filters into every Prisma query", async () => {
    const { database, queries } = harness();

    const report = await queries.getReport(access, request);

    const siteWhere = {
      id: request.siteId,
      brand: {
        id: request.brandId,
        client: { id: request.clientId },
      },
    };
    const marketWhere = {
      is: {
        id: request.siteMarketId,
        site: siteWhere,
      },
    };
    const succeededRunWhere = {
      client: { id: request.clientId },
      brand: { id: request.brandId, client: { id: request.clientId } },
      site: siteWhere,
      siteMarket: marketWhere,
      status: "succeeded",
    };
    const recommendationRunWhere = {
      ...succeededRunWhere,
      status: { in: ["succeeded", "partial"] },
    };
    expect(database.site.findFirst).toHaveBeenCalledWith({
      where: {
        ...siteWhere,
        markets: { some: { id: request.siteMarketId } },
      },
      select: { id: true },
    });
    expect(database.metricSnapshot.findMany).toHaveBeenCalledWith({
      where: {
        formulaVersion: SEO_FORMULA_VERSION,
        calculatedAt: {
          gte: new Date(request.startAt),
          lte: new Date(request.endAt),
        },
        run: succeededRunWhere,
      },
      select: expect.objectContaining({
        id: true,
        runId: true,
        dimensions: true,
      }),
      orderBy: [{ name: "asc" }, { calculatedAt: "desc" }, { id: "asc" }],
    });
    expect(database.recommendation.findMany).toHaveBeenCalledWith({
      where: {
        client: { id: request.clientId },
        site: siteWhere,
        formulaVersion: SEO_FORMULA_VERSION,
        createdAt: {
          gte: new Date(request.startAt),
          lte: new Date(request.endAt),
        },
        run: recommendationRunWhere,
      },
      select: expect.objectContaining({
        evidence: {
          where: { observation: { run: recommendationRunWhere } },
          select: { observationId: true },
          orderBy: { observationId: "asc" },
        },
      }),
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }, { id: "asc" }],
    });
    expect(database.opportunity.findMany).toHaveBeenCalledWith({
      where: {
        client: { id: request.clientId },
        site: siteWhere,
        formulaVersion: SEO_FORMULA_VERSION,
        createdAt: {
          gte: new Date(request.startAt),
          lte: new Date(request.endAt),
        },
        recommendations: {
          some: {
            recommendation: {
              client: { id: request.clientId },
              site: siteWhere,
              formulaVersion: SEO_FORMULA_VERSION,
              run: recommendationRunWhere,
            },
          },
        },
      },
      select: expect.objectContaining({
        recommendations: {
          where: {
            recommendation: {
              client: { id: request.clientId },
              site: siteWhere,
              formulaVersion: SEO_FORMULA_VERSION,
              run: recommendationRunWhere,
            },
          },
          select: { recommendationId: true },
          orderBy: { recommendationId: "asc" },
        },
      }),
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }, { id: "asc" }],
    });
    expect(database.analysisRun.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        client: { id: request.clientId },
        brand: { id: request.brandId, client: { id: request.clientId } },
        site: siteWhere,
        siteMarket: marketWhere,
        createdAt: {
          gte: new Date(request.startAt),
          lte: new Date(request.endAt),
        },
        source: { in: ["siteone", "unlighthouse", "search-console", "matomo"] },
      },
      select: {
        source: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
        observations: {
          select: { observedAt: true },
          orderBy: { observedAt: "asc" },
        },
      },
      orderBy: [{ source: "asc" }, { finishedAt: "desc" }, { id: "asc" }],
    });
    expect(database.analysisRun.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: { in: ["run_1"] },
        ...succeededRunWhere,
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });

    expect(report).toMatchObject({
      formulaVersion: SEO_FORMULA_VERSION,
      scope: {
        clientId: request.clientId,
        brandId: request.brandId,
        siteId: request.siteId,
        siteMarketId: request.siteMarketId,
      },
      dateWindow: { startAt: request.startAt, endAt: request.endAt },
      metrics: {
        technical: [],
        lighthouse: [],
        search: [{ id: "metric_1", value: 0.92 }],
        analytics: [],
      },
      recommendations: [{
        id: "recommendation_1",
        evidenceObservationIds: ["observation_1", "observation_2"],
      }],
      opportunities: [{
        id: "opportunity_1",
        recommendationIds: ["recommendation_1"],
      }],
      comparisons: [{
        name: SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR,
        baseline: null,
        latest: { id: "metric_1", value: 0.92 },
        delta: null,
      }],
      coverage: expect.any(Array),
      isEmpty: false,
    });
    expect(JSON.stringify(report)).not.toMatch(/must-not-leak|token|artifact|secret/i);
  });

  it("rejects a client outside the standard authorization scope before database access", async () => {
    const { database, queries } = harness();

    await expect(queries.getReport(access, { ...request, clientId: "client_2" }))
      .rejects.toMatchObject({ name: "AuthorizationError", code: "CLIENT_FORBIDDEN" });
    expect(database.metricSnapshot.findMany).not.toHaveBeenCalled();
    expect(database.recommendation.findMany).not.toHaveBeenCalled();
    expect(database.opportunity.findMany).not.toHaveBeenCalled();
  });

  it("rejects unowned or inconsistent brand, site, and market scopes before report data queries", async () => {
    for (const invalidScope of [
      { ...request, brandId: "brand_other" },
      { ...request, siteId: "site_other" },
      { ...request, siteMarketId: "market_other" },
    ]) {
      const { database, queries } = harness();
      database.site.findFirst.mockResolvedValueOnce(null);

      await expect(queries.getReport(access, invalidScope)).rejects.toBeInstanceOf(
        SeoReportScopeNotFoundError,
      );
      expect(database.site.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: invalidScope.siteId }),
        select: { id: true },
      });
      expect(database.metricSnapshot.findMany).not.toHaveBeenCalled();
      expect(database.recommendation.findMany).not.toHaveBeenCalled();
      expect(database.opportunity.findMany).not.toHaveBeenCalled();
      expect(database.analysisRun.findMany).not.toHaveBeenCalled();
    }
  });

  it("preflights a cross-client hierarchy even when the caller may access both clients", async () => {
    const { database, queries } = harness();
    const multiClientAccess: AccessScope = { ...access, clientIds: ["client_1", "client_2"] };
    database.site.findFirst.mockResolvedValueOnce(null);

    await expect(queries.getReport(multiClientAccess, {
      ...request,
      clientId: "client_2",
    })).rejects.toMatchObject({
      name: "SeoReportScopeNotFoundError",
      code: "SEO_REPORT_SCOPE_NOT_FOUND",
    });

    expect(database.site.findFirst).toHaveBeenCalledWith({
      where: {
        id: request.siteId,
        brand: {
          id: request.brandId,
          client: { id: "client_2" },
        },
        markets: { some: { id: request.siteMarketId } },
      },
      select: { id: true },
    });
    expect(database.metricSnapshot.findMany).not.toHaveBeenCalled();
    expect(database.recommendation.findMany).not.toHaveBeenCalled();
    expect(database.opportunity.findMany).not.toHaveBeenCalled();
  });

  it("uses an exact null market relation instead of treating an omitted market as every market", async () => {
    const { database, queries } = harness();

    await queries.getReport(access, { ...request, siteMarketId: null });

    expect(database.site.findFirst).toHaveBeenCalledWith({
      where: {
        id: request.siteId,
        brand: {
          id: request.brandId,
          client: { id: request.clientId },
        },
      },
      select: { id: true },
    });
    expect(database.metricSnapshot.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        run: expect.objectContaining({ siteMarket: { is: null } }),
      }),
    }));
  });

  it("keeps partial measurement repairs and their evidence visible while metrics remain succeeded-only", async () => {
    const { database, queries } = harness();
    database.recommendation.findMany.mockResolvedValueOnce([{
      id: "measurement_repair",
      runId: "partial_run",
      title: "Repair SEO measurement coverage",
      detail: "The Search Console source was truncated.",
      priority: "100",
      formulaVersion: SEO_FORMULA_VERSION,
      state: "open",
      ownerId: null,
      dueAt: null,
      createdAt: new Date("2026-07-30T01:00:00.000Z"),
      updatedAt: new Date("2026-07-30T01:00:00.000Z"),
      evidence: [{ observationId: "partial_observation" }],
    }]);

    const report = await queries.getReport(access, request);

    expect(report.recommendations).toMatchObject([{
      id: "measurement_repair",
      evidenceObservationIds: ["partial_observation"],
    }]);
    expect(database.metricSnapshot.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ run: expect.objectContaining({ status: "succeeded" }) }),
    }));
    expect(database.recommendation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        run: expect.objectContaining({ status: { in: ["succeeded", "partial"] } }),
      }),
      select: expect.objectContaining({
        evidence: expect.objectContaining({
          where: {
            observation: {
              run: expect.objectContaining({ status: { in: ["succeeded", "partial"] } }),
            },
          },
        }),
      }),
    }));
  });

  it("builds deterministic dimension-aware metric comparisons and source coverage", async () => {
    const { database, queries } = harness();
    const comparisonDimensions = (aggregation: string): SeoMetricDimensions => ({
      ...dimensions,
      aggregation,
    });
    database.metricSnapshot.findMany.mockResolvedValueOnce([
      {
        id: "metric_b",
        runId: "run_1",
        name: SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR,
        value: "2",
        dimensions: comparisonDimensions("search_console_final_top_rows"),
        formulaVersion: SEO_FORMULA_VERSION,
        calculatedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
      {
        id: "metric_a",
        runId: "run_1",
        name: SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR,
        value: "1",
        dimensions: comparisonDimensions("search_console_final_top_rows"),
        formulaVersion: SEO_FORMULA_VERSION,
        calculatedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
      {
        id: "metric_c",
        runId: "run_1",
        name: SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR,
        value: "4",
        dimensions: comparisonDimensions("search_console_final_top_rows"),
        formulaVersion: SEO_FORMULA_VERSION,
        calculatedAt: new Date("2026-07-10T00:00:00.000Z"),
      },
      {
        id: "metric_incompatible",
        runId: "run_1",
        name: SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR,
        value: "99",
        dimensions: comparisonDimensions("incompatible_aggregation"),
        formulaVersion: SEO_FORMULA_VERSION,
        calculatedAt: new Date("2026-07-09T00:00:00.000Z"),
      },
    ]);
    database.analysisRun.findMany.mockImplementation((query: { select?: Record<string, unknown> }) => {
      if (query.select?.source === true) {
        return Promise.resolve([
          {
            source: "search-console",
            status: "succeeded",
            startedAt: new Date("2026-07-02T00:00:00.000Z"),
            finishedAt: new Date("2026-07-02T01:00:00.000Z"),
            createdAt: new Date("2026-07-02T00:00:00.000Z"),
            observations: [{ observedAt: new Date("2026-07-02T01:00:00.000Z") }],
          },
          {
            source: "search-console",
            status: "partial",
            startedAt: new Date("2026-07-03T00:00:00.000Z"),
            finishedAt: new Date("2026-07-03T01:00:00.000Z"),
            createdAt: new Date("2026-07-03T00:00:00.000Z"),
            observations: [{ observedAt: new Date("2026-07-03T01:00:00.000Z") }],
          },
        ]);
      }
      return Promise.resolve([{ id: "run_1" }]);
    });

    const report = await queries.getReport(access, request);
    const comparable = report.comparisons.find(
      ({ aggregation }) => aggregation === "search_console_final_top_rows",
    );
    const incompatible = report.comparisons.find(
      ({ aggregation }) => aggregation === "incompatible_aggregation",
    );

    expect(report.comparisons.map(({ aggregation }) => aggregation)).toEqual([
      "incompatible_aggregation",
      "search_console_final_top_rows",
    ]);
    expect(comparable).toMatchObject({
      baseline: { id: "metric_a", value: 1, calculatedAt: "2026-07-05T00:00:00.000Z" },
      latest: { id: "metric_c", value: 4, calculatedAt: "2026-07-10T00:00:00.000Z" },
      delta: 3,
    });
    expect(incompatible).toMatchObject({
      baseline: null,
      latest: { id: "metric_incompatible", value: 99 },
      delta: null,
    });
    expect(report.coverage).toContainEqual({
      source: "search-console",
      formulaVersion: SEO_FORMULA_VERSION,
      runCounts: { total: 2, succeeded: 1, partial: 1, failed: 0, other: 0 },
      observedAt: {
        start: "2026-07-02T01:00:00.000Z",
        end: "2026-07-03T01:00:00.000Z",
      },
      latestRunAt: "2026-07-03T01:00:00.000Z",
    });
  });

  it("returns an explicit empty report state when the scoped date window has no report data", async () => {
    const { database, queries } = harness();
    database.metricSnapshot.findMany.mockResolvedValueOnce([]);
    database.recommendation.findMany.mockResolvedValueOnce([]);
    database.opportunity.findMany.mockResolvedValueOnce([]);

    const report = await queries.getReport(access, request);

    expect(report.isEmpty).toBe(true);
    expect(report.comparisons).toEqual([]);
    expect(report.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "siteone", runCounts: { total: 0, succeeded: 0, partial: 0, failed: 0, other: 0 } }),
      expect.objectContaining({ source: "unlighthouse", runCounts: { total: 0, succeeded: 0, partial: 0, failed: 0, other: 0 } }),
      expect.objectContaining({ source: "search-console", runCounts: { total: 0, succeeded: 0, partial: 0, failed: 0, other: 0 } }),
      expect.objectContaining({ source: "matomo", runCounts: { total: 0, succeeded: 0, partial: 0, failed: 0, other: 0 } }),
    ]));
  });

  it.each([
    [{ ...request, startAt: "not-a-date" }],
    [{ ...request, startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-07-01T00:00:00.000Z" }],
    [{ ...request, startAt: "2025-01-01T00:00:00.000Z", endAt: "2026-07-31T00:00:00.000Z" }],
    [{ ...request, siteId: "" }],
  ])("rejects invalid or excessive date/scope input before querying %j", async (invalid) => {
    const { database, queries } = harness();

    await expect(queries.getReport(access, invalid)).rejects.toBeInstanceOf(
      SeoReportQueryInputError,
    );
    expect(database.metricSnapshot.findMany).not.toHaveBeenCalled();
  });

  it("returns deterministically ordered bounded DTO fields even if a database mock is unordered", async () => {
    const { database, queries } = harness();
    database.recommendation.findMany.mockResolvedValueOnce([
      {
        id: "recommendation_b",
        runId: "run_1",
        title: `B\u0000\u202E${"x".repeat(300)}`,
        detail: "B detail",
        priority: "10",
        formulaVersion: SEO_FORMULA_VERSION,
        state: "open",
        ownerId: null,
        dueAt: null,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        evidence: [],
      },
      {
        id: "recommendation_a",
        runId: "run_1",
        title: "A",
        detail: "A detail",
        priority: "20",
        formulaVersion: SEO_FORMULA_VERSION,
        state: "open",
        ownerId: null,
        dueAt: null,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        evidence: [],
      },
    ]);

    const report = await queries.getReport(access, request);

    expect(report.recommendations.map(({ id }) => id)).toEqual([
      "recommendation_a",
      "recommendation_b",
    ]);
    expect(report.recommendations[1].title.length).toBeLessThanOrEqual(160);
    expect(report.recommendations[1].title).not.toContain("\u0000");
    expect(report.recommendations[1].title).not.toContain("\u202E");
  });
});
