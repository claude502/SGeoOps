import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const legacyOwnedModels = [
  "ContentAsset",
  "GeoRun",
  "ChannelVariant",
  "GeoFlowTaskLink",
  "GeoFlowSyncRun",
  "AuditEvent",
  "TrendTopic",
  "VariantMetric",
  "SeoAudit",
  "KeywordRanking",
  "ExportPackage",
  "DistributionDispatch",
  "EventDelivery",
] as const;

function modelBlock(schema: string, model: string): string {
  const match = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  expect(match, `model ${model}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("platform Prisma schema", () => {
  it("keeps the applied enforce migration immutable and contracts defaults later", async () => {
    const enforceMigration = await readFile(
      "prisma/migrations/20260731110000_enforce_platform_scope/migration.sql",
      "utf8",
    );
    const contractMigration = await readFile(
      "prisma/migrations/20260731120000_remove_legacy_ownership_defaults/migration.sql",
      "utf8",
    ).catch(() => "");

    expect(createHash("sha256").update(enforceMigration).digest("hex")).toBe(
      "6ddd77ee631ba35cd0cc2c85b1527dc1b1190bf23a0dd1d6256c7a6e2e689b2c",
    );
    expect(contractMigration).toContain('ALTER COLUMN "clientId" DROP DEFAULT');
    expect(contractMigration).toContain('ALTER COLUMN "brandId" DROP DEFAULT');
    expect(contractMigration).toContain('ALTER COLUMN "siteId" DROP DEFAULT');
    expect(contractMigration).toContain(
      'DROP INDEX IF EXISTS "TrendTopic_keyword_platform_key"',
    );
    expect(contractMigration).toContain(
      'CREATE UNIQUE INDEX "TrendTopic_clientId_keyword_platform_key"',
    );
  });

  it("contains ownership, evidence, auth, and event models", async () => {
    const schema = await readFile("prisma/schema.prisma", "utf8");

    for (const model of [
      "Workspace",
      "Client",
      "Brand",
      "Site",
      "SiteMarket",
      "Competitor",
      "Keyword",
      "User",
      "Session",
      "Account",
      "Verification",
      "WorkspaceMember",
      "Integration",
      "AnalysisRun",
      "RawArtifact",
      "Observation",
      "MetricSnapshot",
      "Recommendation",
      "Opportunity",
      "OpportunityRecommendation",
      "OutboxEvent",
      "InboxEvent",
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
  });

  it("expresses enforced legacy ownership without tenant defaults", async () => {
    const schema = await readFile("prisma/schema.prisma", "utf8");

    for (const model of legacyOwnedModels) {
      const block = modelBlock(schema, model);
      for (const field of ["clientId", "brandId", "siteId"]) {
        expect(block, `${model}.${field}`).toMatch(
          new RegExp(`\\n\\s+${field}\\s+String\\s*\\n`),
        );
        expect(block, `${model}.${field} tenant default`).not.toMatch(
          new RegExp(
            `\\n\\s+${field}\\s+String\\s+@default\\("(?:client_wing_heng|brand_txpuro|site_txpuro_com)"\\)`,
          ),
        );
      }
      expect(block, `${model}.siteMarketId`).toMatch(
        /\n\s+siteMarketId\s+String\?\s*\n/,
      );
      for (const owner of ["Client", "Brand", "Site", "SiteMarket"]) {
        expect(
          schema.match(new RegExp(`"${model}${owner}"`, "g")) ?? [],
          `${model}${owner} relation endpoints`,
        ).toHaveLength(2);
      }
      for (const index of [
        "@@index([clientId, siteId])",
        "@@index([brandId])",
        "@@index([siteId])",
        "@@index([siteMarketId])",
      ]) {
        expect(block, `${model} ${index}`).toContain(index);
      }
    }
  });

  it("expresses modern reverse indexes and documents SQL-only uniques", async () => {
    const schema = await readFile("prisma/schema.prisma", "utf8");
    const expectedIndexes: Record<string, string[]> = {
      Competitor: ["@@index([siteMarketId])"],
      Integration: ["@@index([siteMarketId])"],
      AnalysisRun: ["@@index([brandId])", "@@index([siteMarketId])"],
      Recommendation: ["@@index([runId])", "@@index([siteId])"],
      RecommendationEvidence: ["@@index([observationId])"],
      Opportunity: ["@@index([siteId])"],
      OpportunityRecommendation: ["@@index([recommendationId])"],
    };

    for (const [model, indexes] of Object.entries(expectedIndexes)) {
      const block = modelBlock(schema, model);
      for (const index of indexes) {
        expect(block, `${model} ${index}`).toContain(index);
      }
    }

    expect(schema).toContain(
      '// SQL-only partial unique: ("brandId", "name") WHERE "siteMarketId" IS NULL.',
    );
    expect(schema).toContain(
      '// SQL-only partial unique: ("siteId", "type") WHERE "siteMarketId" IS NULL.',
    );
  });
});
