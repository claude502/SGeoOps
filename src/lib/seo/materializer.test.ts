import { describe, expect, it, vi } from "vitest";

import { SEO_FORMULA_VERSION } from "./metrics";
import { materializeSeoOutputs } from "./materializer";

const scope = {
  clientId: "client_fixture",
  brandId: "brand_fixture",
  siteId: "site_fixture",
  siteMarketId: "market_fixture",
};

function fixtureRun() {
  return {
    id: "run_siteone",
    ...scope,
    source: "siteone",
    status: "succeeded",
    startedAt: new Date("2026-08-01T00:00:00.000Z"),
    finishedAt: new Date("2026-08-01T00:01:00.000Z"),
    observations: [
      {
        id: "observation_http",
        kind: "siteone.http_status",
        subject: "https://fixture.example/",
        value: { statusCode: 200 },
        observedAt: new Date("2026-08-01T00:00:10.000Z"),
      },
      {
        id: "observation_indexable",
        kind: "siteone.indexability",
        subject: "https://fixture.example/",
        value: { indexable: true },
        observedAt: new Date("2026-08-01T00:00:10.000Z"),
      },
      {
        id: "observation_canonical",
        kind: "siteone.canonical_mismatch",
        subject: "https://fixture.example/",
        value: { count: 1 },
        observedAt: new Date("2026-08-01T00:00:10.000Z"),
      },
      {
        id: "observation_title",
        kind: "siteone.title",
        subject: "https://fixture.example/",
        value: { text: "" },
        observedAt: new Date("2026-08-01T00:00:10.000Z"),
      },
      {
        id: "observation_heading",
        kind: "siteone.heading",
        subject: "https://fixture.example/",
        value: { count: 1, errorCount: 0 },
        observedAt: new Date("2026-08-01T00:00:10.000Z"),
      },
      {
        id: "observation_structured",
        kind: "siteone.structured_data",
        subject: "https://fixture.example/",
        value: { count: 1, types: ["Organization"] },
        observedAt: new Date("2026-08-01T00:00:10.000Z"),
      },
      {
        id: "observation_broken_link",
        kind: "siteone.broken_link",
        subject: "https://fixture.example/missing",
        value: {
          sourceUrl: "https://fixture.example/",
          statusCode: 404,
        },
        observedAt: new Date("2026-08-01T00:00:10.000Z"),
      },
    ],
  };
}

function materializerDatabase() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
    analysisRun: {
      findMany: vi.fn().mockResolvedValue([fixtureRun()]),
    },
    metricSnapshot: {
      createMany: vi.fn().mockResolvedValue({ count: 7 }),
    },
    recommendation: {
      upsert: vi.fn().mockResolvedValue({ id: "recommendation_fixture" }),
    },
    opportunity: {
      upsert: vi.fn().mockResolvedValue({ id: "opportunity_fixture" }),
    },
  };
}

describe("materializeSeoOutputs", () => {
  it("writes versioned metrics and evidence-backed opportunities from an owned completed run", async () => {
    const database = materializerDatabase();

    const result = await materializeSeoOutputs(database as never, {
      runId: "run_siteone",
      scope,
    });

    expect(result).toMatchObject({ metrics: 7 });
    expect(database.analysisRun.findMany).toHaveBeenCalledWith({
      where: {
        ...scope,
        status: { in: ["succeeded", "partial"] },
        finishedAt: { not: null },
      },
      select: expect.objectContaining({
        id: true,
        observations: expect.any(Object),
      }),
      orderBy: [{ finishedAt: "asc" }, { id: "asc" }],
    });
    expect(database.metricSnapshot.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          runId: "run_siteone",
          formulaVersion: SEO_FORMULA_VERSION,
          name: "seo.crawl_success_rate",
          value: 1,
        }),
        expect.objectContaining({
          name: "seo.canonical_health_rate",
          value: 0,
        }),
      ]),
    });
    const evidenceIds = database.recommendation.upsert.mock.calls.flatMap(
      ([call]) => call.create.evidence.create.map(({ observationId }: { observationId: string }) => observationId),
    );
    expect(evidenceIds).toEqual(expect.arrayContaining([
      "observation_canonical",
      "observation_title",
    ]));
    expect(database.recommendation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          runId: "run_siteone",
          clientId: scope.clientId,
          siteId: scope.siteId,
          formulaVersion: SEO_FORMULA_VERSION,
        }),
      }),
    );
    expect(database.opportunity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          clientId: scope.clientId,
          siteId: scope.siteId,
          formulaVersion: SEO_FORMULA_VERSION,
          recommendations: expect.objectContaining({
            create: expect.objectContaining({
              recommendationId: expect.stringMatching(/^seo:/),
            }),
          }),
        }),
      }),
    );
  });
});
