import type { execFile as execFileType } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { executeSiteOne } from "../../geo-worker/src/adapters/siteone";
import { executeUnlighthouse } from "../../geo-worker/src/adapters/unlighthouse";
import { AnalysisIngestService } from "../../src/lib/analysis/ingest-service";
import { PrismaAnalysisRepository } from "../../src/lib/analysis/repository";
import { LocalArtifactStore } from "../../src/lib/artifacts/local-store";
import type { AnalysisEnvelope } from "@sgeo/analysis-contract";

const projectRoot = process.cwd();
const integrationEnabled = process.env.SGEO_DATABASE_INTEGRATION === "1";
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
const fixtureUrl = process.env.SEO_LOOP_FIXTURE_URL ?? "";

type ExecFile = typeof execFileType;

let admin: Client;
let prisma: PrismaClient;
let artifactRoot = "";

function publicLookup() {
  return async () => [{ address: "93.184.216.34", family: 4 as const }];
}

function siteOneFixtureExec(): ExecFile {
  return ((
    _binary: string,
    args: readonly string[],
    _options: unknown,
    callback?: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const output = args.find((arg) => arg.startsWith("--output-json-file="));
    if (output === undefined) throw new Error("SiteOne fixture output path is required");
    const destination = output.slice("--output-json-file=".length);
    void readFile(resolve(projectRoot, "geo-worker/test/fixtures/siteone/success.json"))
      .then((body) => writeFile(destination, body))
      .then(() => callback?.(null, "", ""), (error: Error) => callback?.(error, "", ""));
    return {} as ReturnType<ExecFile>;
  }) as unknown as ExecFile;
}

function unlighthouseFixtureExec(): ExecFile {
  return ((
    _binary: string,
    args: readonly string[],
    _options: unknown,
    callback?: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const output = args.find((arg) => arg.startsWith("--output-path="));
    if (output === undefined) throw new Error("Unlighthouse fixture output path is required");
    const destination = join(output.slice("--output-path=".length), "ci-result.json");
    void readFile(resolve(projectRoot, "geo-worker/test/fixtures/unlighthouse/success.json"))
      .then((body) => writeFile(destination, body))
      .then(() => callback?.(null, "", ""), (error: Error) => callback?.(error, "", ""));
    return {} as ReturnType<ExecFile>;
  }) as unknown as ExecFile;
}

async function seedRun(input: {
  id: string;
  source: string;
  sourceVersion: string;
  adapterVersion: string;
}) {
  await prisma.analysisRun.create({
    data: {
      id: input.id,
      clientId: "client_fixture",
      brandId: "brand_fixture",
      siteId: "site_fixture",
      siteMarketId: "market_fixture",
      kind: "seo-audit",
      source: input.source,
      sourceVersion: input.sourceVersion,
      adapterVersion: input.adapterVersion,
      status: "queued",
      inputHash: `sha256:${input.id}`,
      idempotencyKey: `fixture:${input.id}`,
      trigger: "integration",
    },
  });
}

async function ingestArtifact(
  service: AnalysisIngestService,
  artifacts: LocalArtifactStore,
  envelope: AnalysisEnvelope,
  name: string,
  mediaType: string,
  raw: Uint8Array,
) {
  const rawArtifact = await artifacts.put(envelope.runId, name, raw, mediaType);
  return service.ingest({ ...envelope, rawArtifact });
}

describe("SEO loop integration stack", () => {
  it("defines an isolated deterministic fixture and an integration test gate", async () => {
    const compose = await readFile(
      resolve(projectRoot, "deploy/docker-compose.integration.yml"),
      "utf8",
    );

    expect(compose).toContain("fixture-site:");
    expect(compose).toContain("integration-tests:");
    expect(compose).toContain("TEST_DATABASE_URL");
    expect(compose).toContain("npm run test:integration -- tests/integration/seo-loop.test.ts");
    expect(compose).not.toContain("FIRECRAWL_API_KEY");
  });
});

describe.skipIf(!integrationEnabled).sequential(
  "deterministic SiteOne and Unlighthouse SEO loop on PostgreSQL 16",
  () => {
    beforeAll(async () => {
      if (!databaseUrl) {
        throw new Error("TEST_DATABASE_URL is required for database integration tests");
      }
      if (!fixtureUrl) {
        throw new Error("SEO_LOOP_FIXTURE_URL is required for SEO loop integration tests");
      }
      const parsed = new URL(databaseUrl);
      const databaseName = decodeURIComponent(parsed.pathname.slice(1));
      if (!/^sgeo_task9_test(?:_|$)/.test(databaseName)) {
        throw new Error(`Refusing SEO loop integration tests against ${databaseName}`);
      }
      parsed.searchParams.delete("schema");
      const connectionString = parsed.toString();
      admin = new Client({
        connectionString,
        application_name: "sgeo-task9-seo-loop",
      });
      await admin.connect();
      const version = await admin.query<{ version: string }>(
        "SELECT current_setting('server_version_num') AS version",
      );
      expect(Number(version.rows[0]?.version)).toBeGreaterThanOrEqual(160_000);
      expect(Number(version.rows[0]?.version)).toBeLessThan(170_000);
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString }),
      });
      artifactRoot = await mkdtemp(join(tmpdir(), "sgeo-task9-artifacts-"));
    });

    afterAll(async () => {
      await prisma?.$disconnect();
      await admin?.end();
      if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE
          "OpportunityRecommendation", "RecommendationEvidence", "Opportunity",
          "Recommendation", "MetricSnapshot", "Observation", "RawArtifact",
          "OutboxEvent", "AnalysisRun", "SiteMarket", "Site", "Brand", "Client", "Workspace"
        CASCADE
      `);
      await prisma.workspace.create({
        data: { id: "workspace_internal", name: "Fixture workspace", slug: "fixture" },
      });
      await prisma.client.create({
        data: {
          id: "client_fixture",
          workspaceId: "workspace_internal",
          name: "Fixture client",
          slug: "fixture-client",
        },
      });
      await prisma.brand.create({
        data: {
          id: "brand_fixture",
          clientId: "client_fixture",
          name: "Fixture brand",
          slug: "fixture-brand",
          aliases: [],
        },
      });
      await prisma.site.create({
        data: {
          id: "site_fixture",
          brandId: "brand_fixture",
          name: "Fixture site",
          canonicalHost: "fixture.example",
          originHosts: [],
          siteType: "content",
          hostingMode: "hosted",
          canonicalRules: {},
          allowedPublishPaths: ["/"],
        },
      });
      await prisma.siteMarket.create({
        data: {
          id: "market_fixture",
          siteId: "site_fixture",
          country: "MY",
          locale: "en-MY",
          defaultDevice: "desktop",
          timezone: "Asia/Kuala_Lumpur",
        },
      });
    });

    it("serves the SEO fixture, stores provider artifacts, and materializes versioned evidence", async () => {
      const healthy = await fetch(`${fixtureUrl}/`);
      expect(healthy.status).toBe(200);
      await expect(healthy.text()).resolves.toContain("Healthy indexable page");
      await expect((await fetch(`${fixtureUrl}/canonical`)).text()).resolves.toContain(
        "incorrect.example",
      );
      await expect((await fetch(`${fixtureUrl}/missing-title`)).text()).resolves.not.toContain("<title>");
      await expect((await fetch(`${fixtureUrl}/structured`)).text()).resolves.toContain(
        "application/ld+json",
      );
      const slowStartedAt = Date.now();
      expect((await fetch(`${fixtureUrl}/slow`)).status).toBe(200);
      expect(Date.now() - slowStartedAt).toBeGreaterThanOrEqual(900);

      await seedRun({
        id: "run_siteone",
        source: "siteone",
        sourceVersion: "2.5.1",
        adapterVersion: "1.0.0",
      });
      await seedRun({
        id: "run_unlighthouse",
        source: "unlighthouse",
        sourceVersion: "0.18.0",
        adapterVersion: "1.0.0",
      });

      const siteOne = await executeSiteOne({
        runId: "run_siteone",
        clientId: "client_fixture",
        brandId: "brand_fixture",
        siteId: "site_fixture",
        siteMarketId: "market_fixture",
        url: "https://example.test/",
        maxUrls: 25,
        timeoutSeconds: 30,
      }, { execFile: siteOneFixtureExec(), lookup: publicLookup() });
      const unlighthouse = await executeUnlighthouse({
        runId: "run_unlighthouse",
        clientId: "client_fixture",
        brandId: "brand_fixture",
        siteId: "site_fixture",
        siteMarketId: "market_fixture",
        url: "https://audit.example/",
        templateRoutes: ["/", "/pricing"],
        timeoutSeconds: 30,
      }, { execFile: unlighthouseFixtureExec(), lookup: publicLookup() });
      expect(siteOne.rawReport).not.toBeNull();
      expect(unlighthouse.rawReport).not.toBeNull();

      const artifacts = new LocalArtifactStore(artifactRoot);
      const service = new AnalysisIngestService(
        new PrismaAnalysisRepository(prisma),
        artifacts,
      );
      await ingestArtifact(
        service,
        artifacts,
        siteOne.envelope,
        "siteone-report.json",
        "application/json",
        siteOne.rawReport!,
      );
      await ingestArtifact(
        service,
        artifacts,
        unlighthouse.envelope,
        "unlighthouse-json-expanded.json",
        "application/json",
        unlighthouse.rawReport!,
      );

      const [storedArtifacts, metrics, opportunities] = await Promise.all([
        prisma.rawArtifact.findMany({ orderBy: { runId: "asc" } }),
        prisma.metricSnapshot.findMany({ orderBy: { name: "asc" } }),
        prisma.opportunity.findMany({
          include: {
            recommendations: {
              include: { recommendation: { include: { evidence: true } } },
            },
          },
        }),
      ]);
      expect(storedArtifacts.map(({ uri }) => uri)).toEqual([
        "artifact://run_siteone/siteone-report.json",
        "artifact://run_unlighthouse/unlighthouse-json-expanded.json",
      ]);
      expect(metrics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runId: "run_siteone",
          name: "seo.crawl_success_rate",
          formulaVersion: "seo-v1",
        }),
        expect.objectContaining({
          runId: "run_unlighthouse",
          name: "seo.lighthouse.performance_score",
          formulaVersion: "seo-v1",
        }),
      ]));
      expect(opportunities.some((opportunity) =>
        opportunity.recommendations.some(({ recommendation }) =>
          recommendation.evidence.length > 0
        )
      )).toBe(true);
      await expect(artifacts.get(storedArtifacts[0]!.uri)).resolves.toEqual(
        siteOne.rawReport,
      );
    });
  },
);
