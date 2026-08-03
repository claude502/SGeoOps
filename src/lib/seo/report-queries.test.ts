import { describe, expect, it, vi } from "vitest";

import type { AccessScope } from "@/lib/authorization";
import {
  SeoReportQueries,
  SeoReportQueryInputError,
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
      findMany: vi.fn().mockResolvedValue([{ id: "run_1" }]),
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

    const runWhere = {
      clientId: request.clientId,
      brandId: request.brandId,
      siteId: request.siteId,
      siteMarketId: request.siteMarketId,
      status: "succeeded",
    };
    expect(database.metricSnapshot.findMany).toHaveBeenCalledWith({
      where: {
        formulaVersion: SEO_FORMULA_VERSION,
        calculatedAt: {
          gte: new Date(request.startAt),
          lte: new Date(request.endAt),
        },
        run: runWhere,
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
        clientId: request.clientId,
        siteId: request.siteId,
        formulaVersion: SEO_FORMULA_VERSION,
        createdAt: {
          gte: new Date(request.startAt),
          lte: new Date(request.endAt),
        },
        run: runWhere,
      },
      select: expect.objectContaining({
        evidence: {
          where: { observation: { run: runWhere } },
          select: { observationId: true },
          orderBy: { observationId: "asc" },
        },
      }),
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }, { id: "asc" }],
    });
    expect(database.opportunity.findMany).toHaveBeenCalledWith({
      where: {
        clientId: request.clientId,
        siteId: request.siteId,
        formulaVersion: SEO_FORMULA_VERSION,
        createdAt: {
          gte: new Date(request.startAt),
          lte: new Date(request.endAt),
        },
        recommendations: {
          some: {
            recommendation: {
              clientId: request.clientId,
              siteId: request.siteId,
              formulaVersion: SEO_FORMULA_VERSION,
              run: runWhere,
            },
          },
        },
      },
      select: expect.objectContaining({
        recommendations: {
          where: {
            recommendation: {
              clientId: request.clientId,
              siteId: request.siteId,
              formulaVersion: SEO_FORMULA_VERSION,
              run: runWhere,
            },
          },
          select: { recommendationId: true },
          orderBy: { recommendationId: "asc" },
        },
      }),
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }, { id: "asc" }],
    });
    expect(database.analysisRun.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["run_1"] },
        clientId: request.clientId,
        brandId: request.brandId,
        siteId: request.siteId,
        siteMarketId: request.siteMarketId,
        status: "succeeded",
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
        title: `B\u0000${"x".repeat(300)}`,
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
  });
});
