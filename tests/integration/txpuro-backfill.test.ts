import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.SGEO_DATABASE_INTEGRATION === "1";
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
const execFileAsync = promisify(execFile);

const legacyMigrationPaths = [
  "prisma/migrations/20260504120000_geoflow_bridge_init/migration.sql",
  "prisma/migrations/20260504183000_persist_geo_runs_variants/migration.sql",
  "prisma/migrations/20260504195000_add_audit_events/migration.sql",
  "prisma/migrations/20260505013000_add_txpuro_public_content_fields/migration.sql",
  "prisma/migrations/20260506000000_add_content_asset_value_constraints/migration.sql",
  "prisma/migrations/20260506110557_add_seo_trend_engine/migration.sql",
  "prisma/migrations/20260507000000_add_trend_topic_unique_keyword_platform/migration.sql",
  "prisma/migrations/20260611000000_add_export_packages_and_dispatches/migration.sql",
] as const;

const expandMigrationPath =
  "prisma/migrations/20260731090000_platform_foundation_expand/migration.sql";
const backfillMigrationPath =
  "prisma/migrations/20260731100000_backfill_txpuro_ownership/migration.sql";
const enforceMigrationPath =
  "prisma/migrations/20260731110000_enforce_platform_scope/migration.sql";
const contractMigrationPath =
  "prisma/migrations/20260731120000_remove_legacy_ownership_defaults/migration.sql";
const generatedContentMigrationPath =
  "prisma/migrations/20260731130000_generated_content_business_key/migration.sql";

const legacyTables = [
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

const fixedOwnership = {
  workspaceId: "workspace_internal",
  clientId: "client_wing_heng",
  brandId: "brand_txpuro",
  siteId: "site_txpuro_com",
  zhMarketId: "site_market_txpuro_my_zh_cn",
  enMarketId: "site_market_txpuro_my_en",
} as const;

const backfillRelationshipCases = [
  {
    label: "ContentAsset to TrendTopic",
    mutation: `
      UPDATE "TrendTopic"
      SET "siteMarketId" = 'site_market_txpuro_my_en'
      WHERE "id" = 'trend_txpuro'
    `,
  },
  {
    label: "GeoRun to ContentAsset",
    mutation: `
      UPDATE "GeoRun"
      SET "siteMarketId" = 'site_market_txpuro_my_en'
      WHERE "id" = 'geo_run_txpuro_linked'
    `,
  },
  {
    label: "ChannelVariant to ContentAsset",
    mutation: `
      UPDATE "ChannelVariant"
      SET "siteMarketId" = 'site_market_txpuro_my_en'
      WHERE "id" = 'variant_txpuro'
    `,
  },
  {
    label: "GeoFlowTaskLink to ContentAsset",
    mutation: `
      UPDATE "GeoFlowTaskLink"
      SET "siteMarketId" = 'site_market_txpuro_my_en'
      WHERE "id" = 'geoflow_link_txpuro'
    `,
  },
  {
    label: "VariantMetric to ChannelVariant",
    mutation: `
      UPDATE "VariantMetric"
      SET "siteMarketId" = 'site_market_txpuro_my_en'
      WHERE "id" = 'metric_txpuro'
    `,
  },
  {
    label: "ExportPackage to ContentAsset",
    mutation: `
      UPDATE "ExportPackage"
      SET "siteMarketId" = 'site_market_txpuro_my_en'
      WHERE "id" = 'export_txpuro'
    `,
  },
  {
    label: "DistributionDispatch to both parents",
    mutation: `
      UPDATE "DistributionDispatch"
      SET "siteMarketId" = 'site_market_txpuro_my_en'
      WHERE "id" = 'dispatch_txpuro'
    `,
  },
  {
    label: "AuditEvent polymorphic parent",
    mutation: `
      UPDATE "AuditEvent"
      SET "siteMarketId" = 'site_market_txpuro_my_en'
      WHERE "id" = 'audit_txpuro'
    `,
  },
  {
    label: "EventDelivery polymorphic parent",
    mutation: `
      UPDATE "EventDelivery"
      SET "siteMarketId" = 'site_market_txpuro_my_en'
      WHERE "id" = 'delivery_txpuro'
    `,
  },
] as const;

const polymorphicSiteLevelBackfillRejectCases = [
  {
    label: "unknown AuditEvent type with market",
    table: "AuditEvent",
    rowId: "audit_txpuro",
    mutation: `
      UPDATE "AuditEvent"
      SET
        "entityType" = 'GeoBrief',
        "entityId" = 'brief_without_table',
        "siteMarketId" = 'site_market_txpuro_my_zh_cn'
      WHERE "id" = 'audit_txpuro'
    `,
    message: /site-level polymorphic provenance has market.*AuditEvent/i,
  },
  {
    label: "known AuditEvent type with null entity and market",
    table: "AuditEvent",
    rowId: "audit_txpuro",
    mutation: `
      UPDATE "AuditEvent"
      SET
        "entityType" = 'ContentAsset',
        "entityId" = NULL,
        "siteMarketId" = 'site_market_txpuro_my_zh_cn'
      WHERE "id" = 'audit_txpuro'
    `,
    message: /type-level polymorphic audit has market.*AuditEvent/i,
  },
  {
    label: "unknown EventDelivery type with market",
    table: "EventDelivery",
    rowId: "delivery_txpuro",
    mutation: `
      UPDATE "EventDelivery"
      SET
        "entityType" = 'Workspace',
        "entityId" = 'workspace_internal',
        "siteMarketId" = 'site_market_txpuro_my_zh_cn'
      WHERE "id" = 'delivery_txpuro'
    `,
    message: /site-level polymorphic provenance has market.*EventDelivery/i,
  },
] as const;

const polymorphicExactMarketBackfillRejectCases = [
  {
    label: "market-scoped parent with site-level owned child",
    mutation: `
      UPDATE "AuditEvent"
      SET
        "clientId" = 'client_wing_heng',
        "brandId" = 'brand_txpuro',
        "siteId" = 'site_txpuro_com',
        "siteMarketId" = NULL,
        "entityType" = 'content-assets',
        "entityId" = 'asset_txpuro_zh'
      WHERE "id" = 'audit_txpuro'
    `,
  },
  {
    label: "site-level parent with market-scoped child",
    mutation: `
      UPDATE "AuditEvent"
      SET
        "siteMarketId" = 'site_market_txpuro_my_zh_cn',
        "entityType" = 'geoflow_sync_runs',
        "entityId" = 'sync_txpuro'
      WHERE "id" = 'audit_txpuro'
    `,
  },
  {
    label: "parent and child in different markets",
    mutation: `
      UPDATE "AuditEvent"
      SET
        "siteMarketId" = 'site_market_txpuro_my_en',
        "entityType" = 'CONTENT_ASSETS',
        "entityId" = 'asset_txpuro_zh'
      WHERE "id" = 'audit_txpuro'
    `,
  },
] as const;

const polymorphicParents = [
  ["ContentAsset", "asset_txpuro_zh", "content-assets"],
  ["GeoRun", "geo_run_txpuro_linked", "GEORUN"],
  ["ChannelVariant", "variant_txpuro", "channel_variants"],
  ["GeoFlowTaskLink", "geoflow_link_txpuro", "GeoFlowTaskLink"],
  ["GeoFlowSyncRun", "sync_txpuro", "geoflow-sync-runs"],
  ["AuditEvent", "audit_txpuro", "audit_events"],
  ["TrendTopic", "trend_txpuro", "TrendTopic"],
  ["VariantMetric", "metric_txpuro", "variant-metrics"],
  ["SeoAudit", "seo_audit_txpuro", "SEOAUDIT"],
  ["KeywordRanking", "ranking_txpuro", "keyword_rankings"],
  ["ExportPackage", "export_txpuro", "export-packages"],
  ["DistributionDispatch", "dispatch_txpuro", "distribution_dispatches"],
  ["EventDelivery", "delivery_txpuro", "EventDelivery"],
] as const;

type PgError = Error & { code?: string };
type UrlSnapshot = Record<string, Array<Record<string, unknown>>>;

let client: Client;
let pgConnectionString = "";
let mainSchema = "";
let beforeContentCount = 0;
let beforeUrls: UrlSnapshot = {};

function quoteIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function testSchema(label: string): string {
  return `sgeo_task4_${label}_${process.pid}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 10)}`;
}

async function applyMigration(
  target: Client,
  migrationPath: string,
): Promise<void> {
  const sql = await readFile(resolve(migrationPath), "utf8");
  try {
    await target.query(sql);
  } catch (error) {
    await target.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function applyLegacyMigrations(target: Client): Promise<void> {
  for (const migrationPath of legacyMigrationPaths) {
    await applyMigration(target, migrationPath);
  }
}

async function setSearchPath(target: Client, schema: string): Promise<void> {
  await target.query(`SET search_path TO ${quoteIdentifier(schema)}`);
}

async function createFreshSchema(
  target: Client,
  schema: string,
): Promise<void> {
  if (!schema.startsWith("sgeo_task4_")) {
    throw new Error(`Refusing to recreate unguarded schema ${schema}`);
  }
  await target.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
  await target.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await setSearchPath(target, schema);
}

async function withFreshSchema(
  label: string,
  run: (target: Client, schema: string) => Promise<void>,
): Promise<void> {
  const schema = testSchema(label);
  const target = new Client({
    connectionString: pgConnectionString,
    application_name: `sgeo-task4-${label}`,
  });
  await target.connect();
  try {
    await createFreshSchema(target, schema);
    await run(target, schema);
  } finally {
    await target.query("SET search_path TO public");
    await target.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await target.end();
  }
}

async function expectPgError(
  action: () => Promise<unknown>,
  codes: string | string[],
  message: RegExp,
): Promise<void> {
  const acceptedCodes = Array.isArray(codes) ? codes : [codes];
  let caught: PgError | undefined;
  try {
    await action();
  } catch (error) {
    caught = error as PgError;
  }
  expect(caught, "Expected PostgreSQL to reject the statement").toBeDefined();
  expect(acceptedCodes).toContain(caught?.code);
  expect(caught?.message).toMatch(message);
}

async function seedLegacyTxpuroRows(target: Client): Promise<void> {
  await target.query(`
    INSERT INTO "TrendTopic" (
      "id", "keyword", "platform", "score", "region", "sourceType",
      "status", "capturedAt", "createdAt"
    ) VALUES (
      'trend_txpuro', 'Malaysia e-invoice', 'google', 91, 'MY', 'search',
      'active', '2026-07-30T01:00:00.000Z', '2026-07-30T01:00:00.000Z'
    );

    INSERT INTO "ContentAsset" (
      "id", "title", "body", "summary", "brandEntity", "sourceUrl",
      "targetKeywords", "canonicalUrl", "status", "geoScore", "owner",
      "sourceSystem", "externalUrl", "publishedAt", "slug", "locale",
      "assetType", "schemaType", "ctaMode", "publishTarget", "isPublic",
      "publishedPath", "trendTopicId", "createdAt", "updatedAt"
    ) VALUES
    (
      'asset_txpuro_zh', '电子发票指南', 'zh body', 'zh summary', 'Txpuro',
      'http://GEO-ORIGIN.WINGHENGTECH.COM:80/guides/zh-CN/e-invoice',
      ARRAY['电子发票'],
      'https://WWW.TxPuro.Com:443/guides/zh-CN/e-invoice',
      'Ready', 88, 'legacy-owner', 'geo_ops',
      'https://txpuro.com/guides/zh-CN/e-invoice?from=legacy#overview',
      '2026-07-30T02:00:00.000Z', 'e-invoice-zh', 'zh-CN',
      'guide-page', 'article', 'self_signup', 'txpuro', true,
      '/guides/zh-CN/e-invoice', 'trend_txpuro',
      '2026-07-30T01:00:00.000Z', '2026-07-30T01:00:00.000Z'
    ),
    (
      'asset_txpuro_en', 'E-invoice guide', 'en body', 'en summary', 'Txpuro',
      'https://geo-origin.winghengtech.com/guides/en/e-invoice',
      ARRAY['e-invoice'],
      'http://txpuro.com:80/guides/en/e-invoice',
      'Ready', 86, 'legacy-owner', 'geo_ops',
      'https://www.txpuro.com:443/guides/en/e-invoice',
      '2026-07-30T02:00:00.000Z', 'e-invoice-en', 'en',
      'guide-page', 'article', 'self_signup', 'txpuro', true,
      '/guides/en/e-invoice', NULL,
      '2026-07-30T01:00:00.000Z', '2026-07-30T01:00:00.000Z'
    );

    INSERT INTO "GeoRun" (
      "id", "projectId", "contentAssetId", "prompt", "provider", "locale",
      "competitors", "modelAnswer", "brandMentioned", "citedDomains",
      "score", "recommendations", "mode", "createdAt"
    ) VALUES
    (
      'geo_run_txpuro_linked', 'txpuro', 'asset_txpuro_zh', 'prompt',
      'openai', 'zh-CN', ARRAY['competitor'], 'answer', true,
      ARRAY['txpuro.com'], 90, '[]'::jsonb, 'audit',
      '2026-07-30T03:00:00.000Z'
    ),
    (
      'geo_run_txpuro_project', 'txpuro', NULL, 'prompt', 'openai', 'en',
      ARRAY[]::text[], 'answer', true, ARRAY['txpuro.com'], 89,
      '[]'::jsonb, 'audit', '2026-07-30T03:05:00.000Z'
    );

    INSERT INTO "ChannelVariant" (
      "id", "contentAssetId", "platform", "accountId", "copy",
      "mediaAssets", "status", "createdAt", "updatedAt"
    ) VALUES (
      'variant_txpuro', 'asset_txpuro_zh', 'linkedin', 'txpuro-main',
      'variant copy', ARRAY[]::text[], 'ready',
      '2026-07-30T04:00:00.000Z', '2026-07-30T04:00:00.000Z'
    );

    INSERT INTO "GeoFlowTaskLink" (
      "id", "contentAssetId", "geoFlowTaskId", "geoFlowArticleUrl",
      "status", "idempotencyKey", "createdAt", "updatedAt"
    ) VALUES (
      'geoflow_link_txpuro', 'asset_txpuro_zh', 101,
      'https://geo-origin.winghengtech.com/guides/zh-CN/e-invoice',
      'published', 'legacy-geoflow-txpuro',
      '2026-07-30T05:00:00.000Z', '2026-07-30T05:00:00.000Z'
    );

    INSERT INTO "GeoFlowSyncRun" (
      "id", "startedAt", "finishedAt", "successCount", "failureCount"
    ) VALUES (
      'sync_txpuro', '2026-07-30T05:00:00.000Z',
      '2026-07-30T05:05:00.000Z', 1, 0
    );

    INSERT INTO "AuditEvent" (
      "id", "actor", "action", "entityType", "entityId", "outcome",
      "requestId", "metadata", "createdAt"
    ) VALUES (
      'audit_txpuro', 'legacy-user', 'publish', 'ContentAsset',
      'asset_txpuro_zh', 'success', 'request-txpuro',
      '{"source":"legacy"}'::jsonb, '2026-07-30T06:00:00.000Z'
    );

    INSERT INTO "VariantMetric" (
      "id", "channelVariantId", "impressions", "clicks", "shares",
      "recordedAt"
    ) VALUES (
      'metric_txpuro', 'variant_txpuro', 100, 10, 2,
      '2026-07-30T07:00:00.000Z'
    );

    INSERT INTO "SeoAudit" (
      "id", "url", "score", "issues", "cwv", "auditedAt"
    ) VALUES (
      'seo_audit_txpuro',
      'HTTPS://WWW.TXPURO.COM:443/guides/en/technical-audit',
      93, '[]'::jsonb, '{"lcp":1.2}'::jsonb,
      '2026-07-30T08:00:00.000Z'
    );

    INSERT INTO "KeywordRanking" (
      "id", "keyword", "url", "position", "clicks", "impressions",
      "source", "recordedAt"
    ) VALUES (
      'ranking_txpuro', '电子发票',
      'http://geo-origin.winghengtech.com:8080/guides/zh-CN/ranking',
      2, 20, 200, 'search-console', '2026-07-30T09:00:00.000Z'
    );

    INSERT INTO "ExportPackage" (
      "id", "contentAssetId", "version", "language", "status",
      "packageType", "payload", "recommendedPlatforms", "sourceUrl",
      "createdAt", "updatedAt"
    ) VALUES (
      'export_txpuro', 'asset_txpuro_zh', 1, 'zh-CN', 'ready',
      'article', '{"version":1}'::jsonb, ARRAY['linkedin'],
      'https://geo-origin.winghengtech.com/guides/zh-CN/e-invoice',
      '2026-07-30T10:00:00.000Z', '2026-07-30T10:00:00.000Z'
    );

    INSERT INTO "DistributionDispatch" (
      "id", "exportPackageId", "contentAssetId", "platform", "accountId",
      "externalPostId", "publishedUrl", "status", "publishedAt",
      "createdAt", "updatedAt"
    ) VALUES (
      'dispatch_txpuro', 'export_txpuro', 'asset_txpuro_zh', 'website',
      'txpuro-main', 'post-101',
      'https://txpuro.com/guides/zh-CN/e-invoice?dispatch=legacy',
      'published', '2026-07-30T11:00:00.000Z',
      '2026-07-30T10:30:00.000Z', '2026-07-30T11:00:00.000Z'
    );

    INSERT INTO "EventDelivery" (
      "id", "eventName", "entityType", "entityId", "payload", "target",
      "status", "attemptCount", "lastAttemptAt", "createdAt"
    ) VALUES (
      'delivery_txpuro', 'distribution.published', 'DistributionDispatch',
      'dispatch_txpuro',
      '{"url":"https://txpuro.com/guides/zh-CN/e-invoice"}'::jsonb,
      'webhook', 'sent', 1, '2026-07-30T11:01:00.000Z',
      '2026-07-30T11:00:00.000Z'
    );
  `);
}

async function snapshotUrls(target: Client): Promise<UrlSnapshot> {
  const queries: Record<string, string> = {
    ContentAsset: `
      SELECT
        "id", "sourceUrl", "canonicalUrl", "externalUrl", "publishedPath",
        "slug", "locale", "publishTarget"
      FROM "ContentAsset" ORDER BY "id"
    `,
    GeoRun: `SELECT "id", "locale" FROM "GeoRun" ORDER BY "id"`,
    GeoFlowTaskLink: `
      SELECT "id", "geoFlowArticleUrl" FROM "GeoFlowTaskLink" ORDER BY "id"
    `,
    SeoAudit: `SELECT "id", "url" FROM "SeoAudit" ORDER BY "id"`,
    KeywordRanking: `
      SELECT "id", "url" FROM "KeywordRanking" ORDER BY "id"
    `,
    ExportPackage: `
      SELECT "id", "sourceUrl", "language"
      FROM "ExportPackage" ORDER BY "id"
    `,
    DistributionDispatch: `
      SELECT "id", "publishedUrl" FROM "DistributionDispatch" ORDER BY "id"
    `,
    EventDelivery: `
      SELECT "id", "payload" FROM "EventDelivery" ORDER BY "id"
    `,
  };
  const snapshot: UrlSnapshot = {};
  for (const [name, sql] of Object.entries(queries)) {
    snapshot[name] = (await target.query(sql)).rows;
  }
  return snapshot;
}

async function prepareExpandedLegacyFixture(target: Client): Promise<void> {
  await applyLegacyMigrations(target);
  await seedLegacyTxpuroRows(target);
  await applyMigration(target, expandMigrationPath);
}

async function prepareBackfilledFreshSchema(target: Client): Promise<void> {
  await prepareExpandedLegacyFixture(target);
  await applyMigration(target, backfillMigrationPath);
}

async function prepareBaseEnforcedFreshSchema(target: Client): Promise<void> {
  await prepareBackfilledFreshSchema(target);
  await applyMigration(target, enforceMigrationPath);
}

async function prepareEnforcedFreshSchema(target: Client): Promise<void> {
  await prepareBaseEnforcedFreshSchema(target);
  await applyMigration(target, contractMigrationPath);
  await applyMigration(target, generatedContentMigrationPath);
}

async function generatedContentUniqueIndexNames(
  target: Client,
): Promise<string[]> {
  const result = await target.query<{ indexname: string }>(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'ContentAsset'
      AND indexname =
        'ContentAsset_clientId_sourceSystem_trendTopicId_templateId_key'
  `);
  return result.rows.map(({ indexname }) => indexname);
}

async function ownershipDefaultCount(target: Client): Promise<number> {
  const result = await target.query<{ count: number }>(
    `
      SELECT count(*)::int AS count
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
        AND column_name = ANY(ARRAY['clientId', 'brandId', 'siteId'])
        AND column_default IS NOT NULL
    `,
    [legacyTables],
  );
  return result.rows[0]?.count ?? 0;
}

async function trendUniqueIndexNames(target: Client): Promise<string[]> {
  const result = await target.query<{ indexname: string }>(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'TrendTopic'
      AND indexname IN (
        'TrendTopic_keyword_platform_key',
        'TrendTopic_clientId_keyword_platform_key'
      )
    ORDER BY indexname
  `);
  return result.rows.map(({ indexname }) => indexname);
}

async function deployMigrations(schema: string): Promise<void> {
  const deploymentUrl = new URL(pgConnectionString);
  deploymentUrl.searchParams.set("schema", schema);
  await execFileAsync(
    resolve("node_modules/.bin/prisma"),
    ["migrate", "deploy"],
    {
      cwd: resolve("."),
      env: { ...process.env, DATABASE_URL: deploymentUrl.toString() },
    },
  );
}

async function openSchemaClient(
  schema: string,
  applicationName: string,
): Promise<Client> {
  const target = new Client({
    connectionString: pgConnectionString,
    application_name: applicationName,
  });
  await target.connect();
  await setSearchPath(target, schema);
  return target;
}

async function waitForPgCondition(
  target: Client,
  sql: string,
  params: unknown[] = [],
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await target.query<{ matched: boolean }>(sql, params);
    if (result.rows[0]?.matched) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return false;
}

async function cloneAuditEvent(
  target: Client,
  changes: Record<string, unknown>,
): Promise<void> {
  await target.query(
    `
      INSERT INTO "AuditEvent"
      SELECT (
        jsonb_populate_record(
          NULL::"AuditEvent",
          to_jsonb(seed) || $1::jsonb
        )
      ).*
      FROM "AuditEvent" seed
      WHERE "id" = 'audit_txpuro'
    `,
    [JSON.stringify(changes)],
  );
}

async function cloneEventDelivery(
  target: Client,
  changes: Record<string, unknown>,
): Promise<void> {
  await target.query(
    `
      INSERT INTO "EventDelivery"
      SELECT (
        jsonb_populate_record(
          NULL::"EventDelivery",
          to_jsonb(seed) || $1::jsonb
        )
      ).*
      FROM "EventDelivery" seed
      WHERE "id" = 'delivery_txpuro'
    `,
    [JSON.stringify(changes)],
  );
}

async function seedLegacyContentProbe(
  target: Client,
  input: {
    id: string;
    brandEntity: string;
    sourceUrl: string;
    canonicalUrl: string;
    locale?: "en" | "zh-CN";
  },
): Promise<void> {
  const locale = input.locale ?? "en";
  await target.query(
    `
      INSERT INTO "ContentAsset" (
        "id", "title", "body", "summary", "brandEntity", "sourceUrl",
        "targetKeywords", "canonicalUrl", "status", "owner", "slug",
        "locale", "assetType", "schemaType", "ctaMode", "publishTarget",
        "isPublic", "createdAt", "updatedAt"
      ) VALUES (
        $1, 'Txpuro probe', 'body', 'summary', $2, $3,
        ARRAY['txpuro'], $4, 'Ready', 'legacy', $1, $5,
        'guide-page', 'article', 'self_signup', 'geo_ops_internal',
        false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `,
    [
      input.id,
      input.brandEntity,
      input.sourceUrl,
      input.canonicalUrl,
      locale,
    ],
  );
}

async function seedOtherOwnershipRoot(target: Client): Promise<void> {
  await target.query(`
    INSERT INTO "Workspace" (
      "id", "name", "slug", "createdAt", "updatedAt"
    ) VALUES (
      'workspace_other', 'Other Workspace', 'other-workspace',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "Client" (
      "id", "workspaceId", "name", "slug", "createdAt", "updatedAt"
    ) VALUES (
      'client_other', 'workspace_other', 'Other Client', 'other-client',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "Brand" (
      "id", "clientId", "name", "slug", "aliases", "createdAt", "updatedAt"
    ) VALUES (
      'brand_other', 'client_other', 'Other Brand', 'other-brand',
      ARRAY['Other'], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "Site" (
      "id", "brandId", "name", "canonicalHost", "originHosts", "siteType",
      "hostingMode", "canonicalRules", "allowedPublishPaths",
      "createdAt", "updatedAt"
    ) VALUES (
      'site_other_com', 'brand_other', 'Other Site', 'other.example',
      ARRAY['origin.other.example'], 'content', 'hybrid',
      '{"https":true,"www":"redirect"}'::jsonb, ARRAY['/guides'],
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "SiteMarket" (
      "id", "siteId", "country", "locale", "defaultDevice", "timezone",
      "settings", "createdAt", "updatedAt"
    ) VALUES (
      'site_market_other_my_en', 'site_other_com', 'MY', 'en', 'desktop',
      'Asia/Kuala_Lumpur',
      '{"searchEngine":"google.com.my","device":"desktop"}'::jsonb,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `);
}

type FixedRootConflict =
  | "inactive_client"
  | "inactive_site"
  | "wrong_site_name"
  | "wrong_market_settings";

async function seedConflictingFixedRoot(
  target: Client,
  conflict: FixedRootConflict,
): Promise<void> {
  const clientActive = conflict !== "inactive_client";
  const siteActive = conflict !== "inactive_site";
  const siteName = conflict === "wrong_site_name" ? "Txpuro.com" : "Txpuro";
  const zhSettings =
    conflict === "wrong_market_settings"
      ? { searchEngine: "google.com", device: "mobile" }
      : { searchEngine: "google.com.my", device: "desktop" };

  await target.query(`
    INSERT INTO "Workspace" (
      "id", "name", "slug", "createdAt", "updatedAt"
    ) VALUES (
      'workspace_internal', 'Internal GEO SEO Operations', 'internal',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `);
  await target.query(
    `
      INSERT INTO "Client" (
        "id", "workspaceId", "name", "slug", "active",
        "createdAt", "updatedAt"
      ) VALUES (
        'client_wing_heng', 'workspace_internal', 'Wing Heng Technology',
        'wing-heng', $1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `,
    [clientActive],
  );
  await target.query(`
      INSERT INTO "Brand" (
        "id", "clientId", "name", "slug", "aliases", "riskCategory",
        "createdAt", "updatedAt"
      ) VALUES (
        'brand_txpuro', 'client_wing_heng', 'Txpuro', 'txpuro',
        ARRAY['Txpuro', '智慧电子发票系统 Txpuro'], 'standard',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
  `);
  await target.query(
    `
      INSERT INTO "Site" (
        "id", "brandId", "name", "canonicalHost", "originHosts", "siteType",
        "hostingMode", "canonicalRules", "allowedPublishPaths", "active",
        "createdAt", "updatedAt"
      ) VALUES (
        'site_txpuro_com', 'brand_txpuro', $1, 'txpuro.com',
        ARRAY['geo-origin.winghengtech.com'], 'content', 'hybrid',
        '{"https":true,"www":"redirect"}'::jsonb, ARRAY['/guides'], $2,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `,
    [siteName, siteActive],
  );
  await target.query(
    `
      INSERT INTO "SiteMarket" (
        "id", "siteId", "country", "locale", "defaultDevice", "timezone",
        "settings", "createdAt", "updatedAt"
      ) VALUES
      (
        'site_market_txpuro_my_zh_cn', 'site_txpuro_com', 'MY', 'zh-CN',
        'desktop', 'Asia/Kuala_Lumpur', $1::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'site_market_txpuro_my_en', 'site_txpuro_com', 'MY', 'en',
        'desktop', 'Asia/Kuala_Lumpur',
        '{"searchEngine":"google.com.my","device":"desktop"}'::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `,
    [JSON.stringify(zhSettings)],
  );
}

async function seedSecondTenantAndModernRows(target: Client): Promise<void> {
  await target.query(`
    INSERT INTO "Client" (
      "id", "workspaceId", "name", "slug", "createdAt", "updatedAt"
    ) VALUES (
      'client_other', 'workspace_internal', 'Other Client', 'other-client',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "Brand" (
      "id", "clientId", "name", "slug", "aliases", "createdAt", "updatedAt"
    ) VALUES (
      'brand_other', 'client_other', 'Other Brand', 'other-brand',
      ARRAY['Other'], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "Site" (
      "id", "brandId", "name", "canonicalHost", "originHosts", "siteType",
      "hostingMode", "canonicalRules", "allowedPublishPaths",
      "createdAt", "updatedAt"
    ) VALUES (
      'site_other_com', 'brand_other', 'Other Site', 'other.example',
      ARRAY['origin.other.example'], 'content', 'hybrid',
      '{"https":true,"www":"redirect"}'::jsonb, ARRAY['/guides'],
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "SiteMarket" (
      "id", "siteId", "country", "locale", "defaultDevice", "timezone",
      "createdAt", "updatedAt"
    ) VALUES
    (
      'site_market_other_my_zh_cn', 'site_other_com', 'MY', 'zh-CN',
      'desktop', 'Asia/Kuala_Lumpur', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    ),
    (
      'site_market_other_my_en', 'site_other_com', 'MY', 'en',
      'desktop', 'Asia/Kuala_Lumpur', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );

    INSERT INTO "TrendTopic" (
      "id", "clientId", "brandId", "siteId", "siteMarketId", "keyword",
      "platform", "score", "region", "sourceType", "status", "capturedAt"
    ) VALUES (
      'trend_other', 'client_other', 'brand_other', 'site_other_com',
      'site_market_other_my_en', 'Other topic', 'google', 50, 'MY',
      'test', 'active', CURRENT_TIMESTAMP
    );
    INSERT INTO "ContentAsset" (
      "id", "clientId", "brandId", "siteId", "siteMarketId", "title",
      "body", "summary", "brandEntity", "sourceUrl", "targetKeywords",
      "canonicalUrl", "status", "owner", "locale", "publishTarget",
      "trendTopicId", "createdAt", "updatedAt"
    ) VALUES (
      'asset_other', 'client_other', 'brand_other', 'site_other_com',
      'site_market_other_my_en', 'Other asset', 'body', 'summary',
      'Other Brand', 'https://other.example/guides/en/asset',
      ARRAY['other'], 'https://other.example/guides/en/asset', 'Ready',
      'other-owner', 'en', 'geo_ops_internal', 'trend_other',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "ChannelVariant" (
      "id", "clientId", "brandId", "siteId", "siteMarketId",
      "contentAssetId", "platform", "accountId", "copy", "mediaAssets",
      "status", "createdAt", "updatedAt"
    ) VALUES (
      'variant_other', 'client_other', 'brand_other', 'site_other_com',
      'site_market_other_my_en', 'asset_other', 'linkedin', 'other',
      'copy', ARRAY[]::text[], 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "ExportPackage" (
      "id", "clientId", "brandId", "siteId", "siteMarketId",
      "contentAssetId", "version", "language", "status", "packageType",
      "recommendedPlatforms", "sourceUrl", "createdAt", "updatedAt"
    ) VALUES (
      'export_other', 'client_other', 'brand_other', 'site_other_com',
      'site_market_other_my_en', 'asset_other', 1, 'en', 'ready',
      'article', ARRAY['website'], 'https://other.example/guides/en/asset',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );

    INSERT INTO "AnalysisRun" (
      "id", "clientId", "brandId", "siteId", "siteMarketId", "kind",
      "source", "sourceVersion", "adapterVersion", "status", "inputHash",
      "idempotencyKey", "trigger"
    ) VALUES
    (
      'analysis_txpuro', 'client_wing_heng', 'brand_txpuro',
      'site_txpuro_com', 'site_market_txpuro_my_en', 'geo',
      'integration-test', '1', '1', 'succeeded', 'hash-txpuro',
      'idem-analysis-txpuro', 'manual'
    ),
    (
      'analysis_other', 'client_other', 'brand_other', 'site_other_com',
      'site_market_other_my_en', 'geo', 'integration-test', '1', '1',
      'succeeded', 'hash-other', 'idem-analysis-other', 'manual'
    );

    INSERT INTO "Observation" (
      "id", "runId", "kind", "subject", "value", "observedAt"
    ) VALUES
    (
      'observation_txpuro', 'analysis_txpuro', 'mention', 'Txpuro',
      '{"mentioned":true}'::jsonb, CURRENT_TIMESTAMP
    ),
    (
      'observation_other', 'analysis_other', 'mention', 'Other',
      '{"mentioned":true}'::jsonb, CURRENT_TIMESTAMP
    );

    INSERT INTO "Recommendation" (
      "id", "runId", "clientId", "siteId", "title", "detail", "priority",
      "formulaVersion", "createdAt", "updatedAt"
    ) VALUES
    (
      'recommendation_txpuro', 'analysis_txpuro', 'client_wing_heng',
      'site_txpuro_com', 'Txpuro recommendation', 'detail', 1, 'v1',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    ),
    (
      'recommendation_other', 'analysis_other', 'client_other',
      'site_other_com', 'Other recommendation', 'detail', 1, 'v1',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );

    INSERT INTO "RecommendationEvidence" (
      "recommendationId", "observationId"
    ) VALUES (
      'recommendation_txpuro', 'observation_txpuro'
    );

    INSERT INTO "Opportunity" (
      "id", "clientId", "siteId", "title", "priority", "formulaVersion",
      "createdAt", "updatedAt"
    ) VALUES
    (
      'opportunity_txpuro', 'client_wing_heng', 'site_txpuro_com',
      'Txpuro opportunity', 1, 'v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    ),
    (
      'opportunity_other', 'client_other', 'site_other_com',
      'Other opportunity', 1, 'v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );

    INSERT INTO "OpportunityRecommendation" (
      "opportunityId", "recommendationId"
    ) VALUES (
      'opportunity_txpuro', 'recommendation_txpuro'
    );
  `);
}

async function insertLegacyMismatch(
  target: Client,
  table: (typeof legacyTables)[number],
): Promise<void> {
  const uniqueChanges: Partial<Record<(typeof legacyTables)[number], object>> = {
    GeoFlowTaskLink: { idempotencyKey: "cross-insert-geoflow" },
    TrendTopic: { keyword: "cross-insert-topic" },
    ExportPackage: { version: 99 },
  };
  const changes = {
    id: `cross_insert_${table}`,
    clientId: "client_other",
    ...uniqueChanges[table],
  };
  await target.query(
    `
      INSERT INTO ${quoteIdentifier(table)}
      SELECT (
        jsonb_populate_record(
          NULL::${quoteIdentifier(table)},
          to_jsonb(seed) || $1::jsonb
        )
      ).*
      FROM ${quoteIdentifier(table)} seed
      WHERE "clientId" = 'client_wing_heng'
      ORDER BY "id"
      LIMIT 1
    `,
    [JSON.stringify(changes)],
  );
}

describe.skipIf(!integrationEnabled).sequential(
  "Txpuro ownership PostgreSQL migrations",
  () => {
    beforeAll(async () => {
      if (!databaseUrl) {
        throw new Error(
          "TEST_DATABASE_URL is required for database integration tests",
        );
      }

      const parsedUrl = new URL(databaseUrl);
      const databaseName = decodeURIComponent(parsedUrl.pathname.slice(1));
      if (!/^sgeo_task4_test(?:_|$)/.test(databaseName)) {
        throw new Error(
          `Refusing database integration tests against unguarded database ${databaseName}`,
        );
      }
      parsedUrl.searchParams.delete("schema");
      pgConnectionString = parsedUrl.toString();

      client = new Client({
        connectionString: pgConnectionString,
        application_name: "sgeo-task4-main",
      });
      await client.connect();

      const database = await client.query<{
        current_database: string;
        server_version_num: string;
      }>(`
        SELECT current_database(), current_setting('server_version_num')
          AS server_version_num
      `);
      expect(database.rows[0]?.current_database).toBe(databaseName);
      const version = Number(database.rows[0]?.server_version_num);
      expect(version).toBeGreaterThanOrEqual(160_000);
      expect(version).toBeLessThan(170_000);

      mainSchema = testSchema("main");
      await createFreshSchema(client, mainSchema);
      await applyLegacyMigrations(client);
      await seedLegacyTxpuroRows(client);
      beforeContentCount = Number(
        (await client.query(`SELECT count(*)::int AS count FROM "ContentAsset"`))
          .rows[0]?.count,
      );
      beforeUrls = await snapshotUrls(client);
    });

    afterAll(async () => {
      if (!client) return;
      if (mainSchema.startsWith("sgeo_task4_")) {
        await client.query("SET search_path TO public");
        await client.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(mainSchema)} CASCADE`,
        );
      }
      await client.end();
    });

    it("backfills fixed Txpuro ownership without changing legacy URLs", async () => {
      await applyMigration(client, expandMigrationPath);
      await client.query(`
        UPDATE "GeoFlowSyncRun"
        SET "siteMarketId" = 'site_market_txpuro_my_en'
        WHERE "id" = 'sync_txpuro';

        UPDATE "ChannelVariant"
        SET "siteMarketId" = 'site_market_txpuro_my_zh_cn'
        WHERE "id" = 'variant_txpuro';
      `);
      await applyMigration(client, backfillMigrationPath);
      await applyMigration(client, backfillMigrationPath);

      const workspace = await client.query(`
        SELECT "id", "name", "slug" FROM "Workspace" ORDER BY "id"
      `);
      expect(workspace.rows).toEqual([
        {
          id: fixedOwnership.workspaceId,
          name: "Internal GEO SEO Operations",
          slug: "internal",
        },
      ]);

      const ownershipRoot = await client.query(`
        SELECT
          c."id" AS "clientId",
          b."id" AS "brandId",
          b."aliases",
          b."riskCategory",
          c."active" AS "clientActive",
          s."id" AS "siteId",
          s."name" AS "siteName",
          s."active" AS "siteActive",
          s."canonicalHost",
          s."originHosts",
          s."siteType",
          s."hostingMode",
          s."canonicalRules",
          s."allowedPublishPaths"
        FROM "Client" c
        JOIN "Brand" b ON b."clientId" = c."id"
        JOIN "Site" s ON s."brandId" = b."id"
      `);
      expect(ownershipRoot.rows).toEqual([
        {
          clientId: fixedOwnership.clientId,
          brandId: fixedOwnership.brandId,
          aliases: ["Txpuro", "智慧电子发票系统 Txpuro"],
          riskCategory: "standard",
          clientActive: true,
          siteId: fixedOwnership.siteId,
          siteName: "Txpuro",
          siteActive: true,
          canonicalHost: "txpuro.com",
          originHosts: ["geo-origin.winghengtech.com"],
          siteType: "content",
          hostingMode: "hybrid",
          canonicalRules: { https: true, www: "redirect" },
          allowedPublishPaths: ["/guides"],
        },
      ]);

      const markets = await client.query(`
        SELECT
          "id", "siteId", "country", "locale", "defaultDevice", "timezone",
          "settings"
        FROM "SiteMarket"
        WHERE "siteId" = 'site_txpuro_com'
        ORDER BY "locale"
      `);
      expect(markets.rows).toEqual([
        {
          id: fixedOwnership.enMarketId,
          siteId: fixedOwnership.siteId,
          country: "MY",
          locale: "en",
          defaultDevice: "desktop",
          timezone: "Asia/Kuala_Lumpur",
          settings: { searchEngine: "google.com.my", device: "desktop" },
        },
        {
          id: fixedOwnership.zhMarketId,
          siteId: fixedOwnership.siteId,
          country: "MY",
          locale: "zh-CN",
          defaultDevice: "desktop",
          timezone: "Asia/Kuala_Lumpur",
          settings: { searchEngine: "google.com.my", device: "desktop" },
        },
      ]);

      for (const table of legacyTables) {
        const orphan = await client.query(
          `
            SELECT count(*)::int AS count
            FROM ${quoteIdentifier(table)}
            WHERE "clientId" IS NULL
               OR "brandId" IS NULL
               OR "siteId" IS NULL
               OR "clientId" <> $1
               OR "brandId" <> $2
               OR "siteId" <> $3
          `,
          [
            fixedOwnership.clientId,
            fixedOwnership.brandId,
            fixedOwnership.siteId,
          ],
        );
        expect(orphan.rows[0]?.count, table).toBe(0);
      }

      const contentMarkets = await client.query(`
        SELECT "locale", "siteMarketId" FROM "ContentAsset" ORDER BY "locale"
      `);
      expect(contentMarkets.rows).toEqual([
        { locale: "en", siteMarketId: fixedOwnership.enMarketId },
        { locale: "zh-CN", siteMarketId: fixedOwnership.zhMarketId },
      ]);

      const preservedMarketSignals = await client.query(`
        SELECT 'ChannelVariant' AS source, "id", "siteMarketId"
        FROM "ChannelVariant"
        WHERE "id" = 'variant_txpuro'
        UNION ALL
        SELECT 'GeoFlowSyncRun', "id", "siteMarketId"
        FROM "GeoFlowSyncRun"
        WHERE "id" = 'sync_txpuro'
        ORDER BY source
      `);
      expect(preservedMarketSignals.rows).toEqual([
        {
          source: "ChannelVariant",
          id: "variant_txpuro",
          siteMarketId: fixedOwnership.zhMarketId,
        },
        {
          source: "GeoFlowSyncRun",
          id: "sync_txpuro",
          siteMarketId: fixedOwnership.enMarketId,
        },
      ]);

      const inferredMarkets = await client.query(`
        SELECT 'GeoRun' AS source, "id", "siteMarketId"
        FROM "GeoRun"
        UNION ALL
        SELECT 'SeoAudit', "id", "siteMarketId" FROM "SeoAudit"
        UNION ALL
        SELECT 'KeywordRanking', "id", "siteMarketId" FROM "KeywordRanking"
        ORDER BY source, "id"
      `);
      expect(inferredMarkets.rows).toEqual(
        expect.arrayContaining([
          {
            source: "GeoRun",
            id: "geo_run_txpuro_project",
            siteMarketId: fixedOwnership.enMarketId,
          },
          {
            source: "SeoAudit",
            id: "seo_audit_txpuro",
            siteMarketId: fixedOwnership.enMarketId,
          },
          {
            source: "KeywordRanking",
            id: "ranking_txpuro",
            siteMarketId: fixedOwnership.zhMarketId,
          },
        ]),
      );

      const contentCount = Number(
        (await client.query(`SELECT count(*)::int AS count FROM "ContentAsset"`))
          .rows[0]?.count,
      );
      expect(contentCount).toBe(beforeContentCount);
      expect(await snapshotUrls(client)).toEqual(beforeUrls);

      const orphanCounts = await client.query(`
        SELECT
          (SELECT count(*)::int FROM "ContentAsset"
            WHERE "clientId" IS NULL OR "brandId" IS NULL OR "siteId" IS NULL)
            AS "contentAssets",
          (SELECT count(*)::int FROM "GeoRun"
            WHERE "clientId" IS NULL OR "brandId" IS NULL OR "siteId" IS NULL)
            AS "geoRuns",
          (SELECT count(*)::int FROM "ExportPackage"
            WHERE "clientId" IS NULL OR "brandId" IS NULL OR "siteId" IS NULL)
            AS "exports",
          (SELECT count(*)::int FROM "DistributionDispatch"
            WHERE "clientId" IS NULL OR "brandId" IS NULL OR "siteId" IS NULL)
            AS "dispatches"
      `);
      expect(orphanCounts.rows[0]).toEqual({
        contentAssets: 0,
        geoRuns: 0,
        exports: 0,
        dispatches: 0,
      });
    });

    it("enforces legacy nullability, foreign keys, triggers, and indexes", async () => {
      await applyMigration(client, enforceMigrationPath);
      await applyMigration(client, contractMigrationPath);
      await applyMigration(client, generatedContentMigrationPath);

      const nullability = await client.query<{
        table_name: string;
        column_name: string;
        is_nullable: string;
      }>(`
        SELECT table_name, column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
          AND column_name = ANY(ARRAY['clientId', 'brandId', 'siteId'])
        ORDER BY table_name, column_name
      `, [legacyTables]);
      expect(nullability.rows).toHaveLength(legacyTables.length * 3);
      expect(nullability.rows.every((column) => column.is_nullable === "NO")).toBe(
        true,
      );

      const ownershipDefaults = await client.query<{
        table_name: string;
        column_name: string;
        column_default: string | null;
      }>(`
        SELECT table_name, column_name, column_default
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
          AND column_name = ANY(ARRAY['clientId', 'brandId', 'siteId'])
        ORDER BY table_name, column_name
      `, [legacyTables]);
      expect(ownershipDefaults.rows).toHaveLength(legacyTables.length * 3);
      for (const column of ownershipDefaults.rows) {
        expect(column.column_default, `${column.table_name}.${column.column_name}`)
          .toBeNull();
      }

      await expect(
        client.query(`
          INSERT INTO "TrendTopic" (
            "keyword", "platform", "score", "sourceType", "capturedAt"
          ) VALUES (
            'must have ownership', 'manual', 50, 'manual', CURRENT_TIMESTAMP
          )
        `),
      ).rejects.toMatchObject({ code: "23502" });

      const foreignKeys = await client.query<{
        table_name: string;
        constraint_name: string;
        definition: string;
      }>(`
        SELECT
          c.conrelid::regclass::text AS table_name,
          c.conname AS constraint_name,
          pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid = ANY(
            SELECT format('%I.%I', current_schema(), table_name)::regclass
            FROM information_schema.tables
            WHERE table_schema = current_schema()
              AND table_name = ANY($1::text[])
          )
          AND c.conname ~ '_(clientId|brandId|siteId|siteMarketId)_fkey$'
      `, [legacyTables]);
      expect(foreignKeys.rows).toHaveLength(legacyTables.length * 4);
      expect(
        foreignKeys.rows.every((foreignKey) =>
          foreignKey.definition.includes("ON DELETE RESTRICT"),
        ),
      ).toBe(true);

      const expectedIndexes = [
        ...legacyTables.flatMap((table) => [
          `${table}_clientId_siteId_idx`,
          `${table}_brandId_idx`,
          `${table}_siteId_idx`,
          `${table}_siteMarketId_idx`,
        ]),
        "Integration_siteMarketId_idx",
        "AnalysisRun_brandId_idx",
        "AnalysisRun_siteMarketId_idx",
        "Recommendation_runId_idx",
        "Recommendation_siteId_idx",
        "RecommendationEvidence_observationId_idx",
        "Opportunity_siteId_idx",
        "OpportunityRecommendation_recommendationId_idx",
        "Competitor_siteMarketId_idx",
        "AuditEvent_entityId_idx",
        "EventDelivery_entityId_idx",
        "Competitor_brandId_name_null_market_key",
        "Integration_siteId_type_null_market_key",
      ];
      const indexes = await client.query<{ indexname: string }>(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = current_schema()
      `);
      const actualIndexes = new Set(indexes.rows.map((index) => index.indexname));
      for (const index of expectedIndexes) {
        expect(actualIndexes.has(index), index).toBe(true);
      }

      const triggerDefinitions = await client.query<{
        trigger_name: string;
        definition: string;
        is_deferrable: boolean;
        is_initially_deferred: boolean;
      }>(`
        SELECT
          t.tgname AS trigger_name,
          pg_get_triggerdef(t.oid) AS definition,
          t.tgdeferrable AS is_deferrable,
          t.tginitdeferred AS is_initially_deferred
        FROM pg_trigger t
        WHERE NOT t.tgisinternal
          AND t.tgrelid = ANY(
            SELECT format('%I.%I', current_schema(), table_name)::regclass
            FROM information_schema.tables
            WHERE table_schema = current_schema()
          )
      `);
      for (const table of legacyTables) {
        const trigger = triggerDefinitions.rows.find(
          (candidate) =>
            candidate.trigger_name === `ownership_scope_${table}`,
        );
        expect(trigger?.definition, table).toContain(
          "AFTER INSERT OR UPDATE",
        );
        expect(trigger?.is_deferrable, table).toBe(false);
        expect(trigger?.is_initially_deferred, table).toBe(false);
      }

      await expectPgError(
        () =>
          client.query(`
            UPDATE "ContentAsset" SET "clientId" = NULL
            WHERE "id" = 'asset_txpuro_zh'
          `),
        "23502",
        /null value in column "clientId"/i,
      );

      await client.query("BEGIN");
      try {
        await expectPgError(
          () =>
            client.query(
              `SET CONSTRAINTS "ownership_scope_ContentAsset" DEFERRED`,
            ),
          "42809",
          /constraint.*(is not deferrable|wrong object type)/i,
        );
      } finally {
        await client.query("ROLLBACK");
      }
    });

    it("rejects cross-tenant inserts and updates for every legacy table", async () => {
      await seedSecondTenantAndModernRows(client);

      const legacyUniqueChanges: Partial<
        Record<(typeof legacyTables)[number], string>
      > = {
        GeoFlowTaskLink: "idempotencyKey",
        TrendTopic: "keyword",
        ExportPackage: "version",
      };

      for (const table of legacyTables) {
        const ownershipError = new RegExp(
          `(tenant ownership mismatch.*${table}|polymorphic ownership mismatch.*${table})`,
          "i",
        );
        await expectPgError(
          () => insertLegacyMismatch(client, table),
          "23514",
          ownershipError,
        );
        await expectPgError(
          () =>
            client.query(
              `
                UPDATE ${quoteIdentifier(table)}
                SET "clientId" = 'client_other'
                WHERE "id" = (
                  SELECT "id" FROM ${quoteIdentifier(table)}
                  WHERE "id" NOT LIKE 'cross_insert_%'
                    AND "clientId" = 'client_wing_heng'
                  ORDER BY "id" LIMIT 1
                )
              `,
            ),
          "23514",
          ownershipError,
        );
        expect(legacyUniqueChanges[table] ?? "id").toBeTruthy();
      }
    });

    it("rejects cross-tenant references along legacy parent chains", async () => {
      const relationshipTriggers = await client.query<{ tgname: string }>(`
        SELECT tgname
        FROM pg_trigger
        WHERE tgrelid = '"ContentAsset"'::regclass
          AND NOT tgisinternal
      `);
      expect(relationshipTriggers.rows.map((trigger) => trigger.tgname)).toContain(
        "ownership_zz_relationship_ContentAsset",
      );
      await expectPgError(
        () =>
          client.query(`
            SELECT "assert_legacy_reference_scope"(
              'client_wing_heng',
              'brand_txpuro',
              'site_txpuro_com',
              'site_market_txpuro_my_en',
              'TrendTopic',
              'trend_other',
              'ContentAsset diagnostic'
            )
          `),
        "23514",
        /referenced ownership mismatch.*ContentAsset.*TrendTopic/i,
      );

      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "ContentAsset" (
              "id", "clientId", "brandId", "siteId", "siteMarketId",
              "title", "body", "summary", "brandEntity", "sourceUrl",
              "targetKeywords", "canonicalUrl", "status", "owner", "locale",
              "publishTarget", "trendTopicId", "createdAt", "updatedAt"
            ) VALUES (
              'asset_cross_topic', 'client_wing_heng', 'brand_txpuro',
              'site_txpuro_com', 'site_market_txpuro_my_en', 'Cross topic',
              'body', 'summary', 'Txpuro',
              'https://txpuro.com/guides/en/cross-topic', ARRAY['cross'],
              'https://txpuro.com/guides/en/cross-topic', 'Ready', 'test',
              'en', 'txpuro', 'trend_other', CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            )
          `),
        "23514",
        /referenced ownership mismatch.*ContentAsset.*TrendTopic/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "ContentAsset" SET "trendTopicId" = 'trend_other'
            WHERE "id" = 'asset_txpuro_en'
          `),
        "23514",
        /referenced ownership mismatch.*ContentAsset.*TrendTopic/i,
      );

      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "GeoRun"
            SELECT (
              jsonb_populate_record(
                NULL::"GeoRun",
                to_jsonb(seed) || '{"id":"geo_run_cross","contentAssetId":"asset_other"}'::jsonb
              )
            ).*
            FROM "GeoRun" seed
            WHERE "id" = 'geo_run_txpuro_linked'
          `),
        "23514",
        /referenced ownership mismatch.*GeoRun.*ContentAsset/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "GeoRun" SET "contentAssetId" = 'asset_other'
            WHERE "id" = 'geo_run_txpuro_linked'
          `),
        "23514",
        /referenced ownership mismatch.*GeoRun.*ContentAsset/i,
      );

      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "ChannelVariant"
            SELECT (
              jsonb_populate_record(
                NULL::"ChannelVariant",
                to_jsonb(seed) || '{"id":"variant_cross","contentAssetId":"asset_other"}'::jsonb
              )
            ).*
            FROM "ChannelVariant" seed
            WHERE "id" = 'variant_txpuro'
          `),
        "23514",
        /referenced ownership mismatch.*ChannelVariant.*ContentAsset/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "ChannelVariant" SET "contentAssetId" = 'asset_other'
            WHERE "id" = 'variant_txpuro'
          `),
        "23514",
        /referenced ownership mismatch.*ChannelVariant.*ContentAsset/i,
      );

      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "GeoFlowTaskLink"
            SELECT (
              jsonb_populate_record(
                NULL::"GeoFlowTaskLink",
                to_jsonb(seed) || jsonb_build_object(
                  'id', 'geoflow_cross',
                  'contentAssetId', 'asset_other',
                  'idempotencyKey', 'geoflow-cross-parent'
                )
              )
            ).*
            FROM "GeoFlowTaskLink" seed
            WHERE "id" = 'geoflow_link_txpuro'
          `),
        "23514",
        /referenced ownership mismatch.*GeoFlowTaskLink.*ContentAsset/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "GeoFlowTaskLink" SET "contentAssetId" = 'asset_other'
            WHERE "id" = 'geoflow_link_txpuro'
          `),
        "23514",
        /referenced ownership mismatch.*GeoFlowTaskLink.*ContentAsset/i,
      );

      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "VariantMetric"
            SELECT (
              jsonb_populate_record(
                NULL::"VariantMetric",
                to_jsonb(seed) || '{"id":"metric_cross","channelVariantId":"variant_other"}'::jsonb
              )
            ).*
            FROM "VariantMetric" seed
            WHERE "id" = 'metric_txpuro'
          `),
        "23514",
        /referenced ownership mismatch.*VariantMetric.*ChannelVariant/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "VariantMetric" SET "channelVariantId" = 'variant_other'
            WHERE "id" = 'metric_txpuro'
          `),
        "23514",
        /referenced ownership mismatch.*VariantMetric.*ChannelVariant/i,
      );

      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "ExportPackage"
            SELECT (
              jsonb_populate_record(
                NULL::"ExportPackage",
                to_jsonb(seed) || jsonb_build_object(
                  'id', 'export_cross',
                  'contentAssetId', 'asset_other',
                  'version', 99
                )
              )
            ).*
            FROM "ExportPackage" seed
            WHERE "id" = 'export_txpuro'
          `),
        "23514",
        /referenced ownership mismatch.*ExportPackage.*ContentAsset/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "ExportPackage"
            SET "contentAssetId" = 'asset_other', "version" = 99
            WHERE "id" = 'export_txpuro'
          `),
        "23514",
        /referenced ownership mismatch.*ExportPackage.*ContentAsset/i,
      );

      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "DistributionDispatch"
            SELECT (
              jsonb_populate_record(
                NULL::"DistributionDispatch",
                to_jsonb(seed) || jsonb_build_object(
                  'id', 'dispatch_cross',
                  'exportPackageId', 'export_other'
                )
              )
            ).*
            FROM "DistributionDispatch" seed
            WHERE "id" = 'dispatch_txpuro'
          `),
        "23514",
        /referenced ownership mismatch.*DistributionDispatch.*ExportPackage/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "DistributionDispatch"
            SET "exportPackageId" = 'export_other'
            WHERE "id" = 'dispatch_txpuro'
          `),
        "23514",
        /referenced ownership mismatch.*DistributionDispatch.*ExportPackage/i,
      );

      await expectPgError(
        () =>
          client.query(`
            UPDATE "TrendTopic"
            SET
              "clientId" = 'client_wing_heng',
              "brandId" = 'brand_txpuro',
              "siteId" = 'site_txpuro_com',
              "siteMarketId" = 'site_market_txpuro_my_en'
            WHERE "id" = 'trend_other'
          `),
        "23514",
        /referenced ownership mismatch.*ContentAsset.*TrendTopic/i,
      );
    });

    it("rejects inconsistent ownership across modern platform models", async () => {
      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "AnalysisRun" (
              "id", "clientId", "brandId", "siteId", "siteMarketId", "kind",
              "source", "sourceVersion", "adapterVersion", "status",
              "inputHash", "idempotencyKey", "trigger"
            ) VALUES (
              'analysis_cross', 'client_other', 'brand_txpuro',
              'site_txpuro_com', 'site_market_txpuro_my_en', 'geo',
              'test', '1', '1', 'succeeded', 'hash-cross',
              'idem-analysis-cross', 'manual'
            )
          `),
        "23514",
        /tenant ownership mismatch.*AnalysisRun/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "AnalysisRun"
            SET
              "clientId" = 'client_other',
              "brandId" = 'brand_other',
              "siteId" = 'site_other_com',
              "siteMarketId" = 'site_market_other_my_en'
            WHERE "id" = 'analysis_txpuro'
          `),
        "23514",
        /run ownership mismatch.*Recommendation/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "AnalysisRun" SET "clientId" = 'client_other'
            WHERE "id" = 'analysis_txpuro'
          `),
        "23514",
        /tenant ownership mismatch.*AnalysisRun/i,
      );

      await client.query(`
        INSERT INTO "Competitor" (
          "id", "brandId", "siteMarketId", "name", "aliases",
          "createdAt", "updatedAt"
        ) VALUES (
          'competitor_valid', 'brand_txpuro', 'site_market_txpuro_my_en',
          'Valid competitor', ARRAY[]::text[], CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
      `);
      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "Competitor" (
              "id", "brandId", "siteMarketId", "name", "aliases",
              "createdAt", "updatedAt"
            ) VALUES (
              'competitor_cross', 'brand_txpuro',
              'site_market_other_my_en', 'Cross competitor',
              ARRAY[]::text[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
          `),
        "23514",
        /market does not belong to brand.*Competitor/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "Competitor"
            SET "siteMarketId" = 'site_market_other_my_en'
            WHERE "id" = 'competitor_valid'
          `),
        "23514",
        /market does not belong to brand.*Competitor/i,
      );

      await client.query(`
        INSERT INTO "Integration" (
          "id", "siteId", "siteMarketId", "type", "capabilities",
          "adapterVersion", "createdAt", "updatedAt"
        ) VALUES (
          'integration_valid', 'site_txpuro_com',
          'site_market_txpuro_my_en', 'valid-adapter', ARRAY['read'], '1',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `);
      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "Integration" (
              "id", "siteId", "siteMarketId", "type", "capabilities",
              "adapterVersion", "createdAt", "updatedAt"
            ) VALUES (
              'integration_cross', 'site_txpuro_com',
              'site_market_other_my_en', 'cross-adapter', ARRAY['read'], '1',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
          `),
        "23514",
        /market does not belong to site.*Integration/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "Integration"
            SET "siteMarketId" = 'site_market_other_my_en'
            WHERE "id" = 'integration_valid'
          `),
        "23514",
        /market does not belong to site.*Integration/i,
      );

      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "Recommendation" (
              "id", "runId", "clientId", "siteId", "title", "detail",
              "priority", "formulaVersion", "createdAt", "updatedAt"
            ) VALUES (
              'recommendation_cross', 'analysis_txpuro', 'client_other',
              'site_other_com', 'Cross', 'detail', 1, 'v1',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
          `),
        "23514",
        /run ownership mismatch.*Recommendation/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "Recommendation"
            SET
              "runId" = 'analysis_other',
              "clientId" = 'client_other',
              "siteId" = 'site_other_com'
            WHERE "id" = 'recommendation_txpuro'
          `),
        "23514",
        /(observation ownership mismatch.*RecommendationEvidence|endpoint ownership mismatch.*OpportunityRecommendation)/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "Recommendation" SET "clientId" = 'client_other'
            WHERE "id" = 'recommendation_txpuro'
          `),
        "23514",
        /run ownership mismatch.*Recommendation/i,
      );

      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "Opportunity" (
              "id", "clientId", "siteId", "title", "priority",
              "formulaVersion", "createdAt", "updatedAt"
            ) VALUES (
              'opportunity_cross', 'client_wing_heng', 'site_other_com',
              'Cross', 1, 'v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
          `),
        "23514",
        /site does not belong to client.*Opportunity/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "Opportunity"
            SET "clientId" = 'client_other', "siteId" = 'site_other_com'
            WHERE "id" = 'opportunity_txpuro'
          `),
        "23514",
        /endpoint ownership mismatch.*OpportunityRecommendation/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "Opportunity" SET "siteId" = 'site_other_com'
            WHERE "id" = 'opportunity_txpuro'
          `),
        "23514",
        /site does not belong to client.*Opportunity/i,
      );

      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "RecommendationEvidence" (
              "recommendationId", "observationId"
            ) VALUES (
              'recommendation_txpuro', 'observation_other'
            )
          `),
        "23514",
        /observation ownership mismatch.*RecommendationEvidence/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "Observation" SET "runId" = 'analysis_other'
            WHERE "id" = 'observation_txpuro'
          `),
        "23514",
        /observation ownership mismatch.*RecommendationEvidence/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "RecommendationEvidence"
            SET "observationId" = 'observation_other'
            WHERE "recommendationId" = 'recommendation_txpuro'
              AND "observationId" = 'observation_txpuro'
          `),
        "23514",
        /observation ownership mismatch.*RecommendationEvidence/i,
      );

      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "OpportunityRecommendation" (
              "opportunityId", "recommendationId"
            ) VALUES (
              'opportunity_txpuro', 'recommendation_other'
            )
          `),
        "23514",
        /endpoint ownership mismatch.*OpportunityRecommendation/i,
      );

      await expectPgError(
        () =>
          client.query(`
            UPDATE "Site" SET "brandId" = 'brand_other'
            WHERE "id" = 'site_txpuro_com'
          `),
        "23514",
        /tenant parent reassignment is not allowed.*Site/i,
      );
      await expectPgError(
        () =>
          client.query(`
            UPDATE "OpportunityRecommendation"
            SET "recommendationId" = 'recommendation_other'
            WHERE "opportunityId" = 'opportunity_txpuro'
              AND "recommendationId" = 'recommendation_txpuro'
          `),
        "23514",
        /endpoint ownership mismatch.*OpportunityRecommendation/i,
      );
    });

    it("enforces nullable-scope uniqueness including concurrent inserts", async () => {
      await client.query(`
        INSERT INTO "Competitor" (
          "id", "brandId", "siteMarketId", "name", "aliases",
          "createdAt", "updatedAt"
        ) VALUES
        (
          'competitor_null_1', 'brand_txpuro', NULL, 'Null Scope',
          ARRAY[]::text[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'competitor_market_zh', 'brand_txpuro',
          'site_market_txpuro_my_zh_cn', 'Per Market',
          ARRAY[]::text[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'competitor_market_en', 'brand_txpuro',
          'site_market_txpuro_my_en', 'Per Market',
          ARRAY[]::text[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      `);
      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "Competitor" (
              "id", "brandId", "siteMarketId", "name", "aliases",
              "createdAt", "updatedAt"
            ) VALUES (
              'competitor_null_2', 'brand_txpuro', NULL, 'Null Scope',
              ARRAY[]::text[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
          `),
        "23505",
        /Competitor_brandId_name_null_market_key/,
      );

      await client.query(`
        INSERT INTO "Integration" (
          "id", "siteId", "siteMarketId", "type", "capabilities",
          "adapterVersion", "createdAt", "updatedAt"
        ) VALUES
        (
          'integration_null_1', 'site_txpuro_com', NULL, 'null-scope',
          ARRAY['read'], '1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'integration_market_zh', 'site_txpuro_com',
          'site_market_txpuro_my_zh_cn', 'per-market',
          ARRAY['read'], '1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'integration_market_en', 'site_txpuro_com',
          'site_market_txpuro_my_en', 'per-market',
          ARRAY['read'], '1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      `);
      await expectPgError(
        () =>
          client.query(`
            INSERT INTO "Integration" (
              "id", "siteId", "siteMarketId", "type", "capabilities",
              "adapterVersion", "createdAt", "updatedAt"
            ) VALUES (
              'integration_null_2', 'site_txpuro_com', NULL, 'null-scope',
              ARRAY['read'], '1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
          `),
        "23505",
        /Integration_siteId_type_null_market_key/,
      );

      const concurrentA = new Client({ connectionString: pgConnectionString });
      const concurrentB = new Client({ connectionString: pgConnectionString });
      await Promise.all([concurrentA.connect(), concurrentB.connect()]);
      try {
        await Promise.all([
          setSearchPath(concurrentA, mainSchema),
          setSearchPath(concurrentB, mainSchema),
        ]);
        await concurrentA.query("BEGIN");
        await concurrentA.query(`
          INSERT INTO "Competitor" (
            "id", "brandId", "siteMarketId", "name", "aliases",
            "createdAt", "updatedAt"
          ) VALUES (
            'competitor_concurrent_a', 'brand_txpuro', NULL,
            'Concurrent Scope', ARRAY[]::text[], CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
        `);
        const losingInsert = concurrentB.query(`
          INSERT INTO "Competitor" (
            "id", "brandId", "siteMarketId", "name", "aliases",
            "createdAt", "updatedAt"
          ) VALUES (
            'competitor_concurrent_b', 'brand_txpuro', NULL,
            'Concurrent Scope', ARRAY[]::text[], CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
        `);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        await concurrentA.query("COMMIT");
        await expectPgError(
          () => losingInsert,
          "23505",
          /Competitor_brandId_name_null_market_key/,
        );
      } finally {
        await Promise.allSettled([
          concurrentA.query("ROLLBACK"),
          concurrentB.query("ROLLBACK"),
        ]);
        await Promise.all([concurrentA.end(), concurrentB.end()]);
      }
    });

    it("rejects invalid existing market signals without overwriting them", async () => {
      await withFreshSchema("market_missing_site_level", async (marketClient) => {
        await prepareExpandedLegacyFixture(marketClient);
        await marketClient.query(`
          UPDATE "GeoFlowSyncRun"
          SET "siteMarketId" = 'site_market_missing'
          WHERE "id" = 'sync_txpuro'
        `);

        await expectPgError(
          () => applyMigration(marketClient, backfillMigrationPath),
          "P0001",
          /market ownership signal.*GeoFlowSyncRun.*sync_txpuro/i,
        );
        const fixedRoot = await marketClient.query(`
          SELECT count(*)::int AS count
          FROM "Workspace" WHERE "id" = 'workspace_internal'
        `);
        expect(fixedRoot.rows[0]?.count).toBe(0);
      });

      await withFreshSchema("market_other_descendant", async (marketClient) => {
        await prepareExpandedLegacyFixture(marketClient);
        await seedOtherOwnershipRoot(marketClient);
        await marketClient.query(`
          UPDATE "ChannelVariant"
          SET "siteMarketId" = 'site_market_other_my_en'
          WHERE "id" = 'variant_txpuro'
        `);

        await expectPgError(
          () => applyMigration(marketClient, backfillMigrationPath),
          "P0001",
          /market ownership signal.*ChannelVariant.*variant_txpuro/i,
        );
        const fixedRoot = await marketClient.query(`
          SELECT count(*)::int AS count
          FROM "Workspace" WHERE "id" = 'workspace_internal'
        `);
        expect(fixedRoot.rows[0]?.count).toBe(0);
      });

      await withFreshSchema("market_tuple_mismatch", async (marketClient) => {
        await prepareExpandedLegacyFixture(marketClient);
        await seedOtherOwnershipRoot(marketClient);
        await marketClient.query(`
          UPDATE "GeoFlowSyncRun"
          SET
            "clientId" = 'client_other',
            "brandId" = 'brand_other',
            "siteId" = 'site_other_com',
            "siteMarketId" = 'site_market_txpuro_my_en'
          WHERE "id" = 'sync_txpuro'
        `);

        await expectPgError(
          () => applyMigration(marketClient, backfillMigrationPath),
          "P0001",
          /ownership chain.*GeoFlowSyncRun.*sync_txpuro/i,
        );
        const fixedRoot = await marketClient.query(`
          SELECT count(*)::int AS count
          FROM "Workspace" WHERE "id" = 'workspace_internal'
        `);
        expect(fixedRoot.rows[0]?.count).toBe(0);
      });

      await withFreshSchema("market_inherited_root_mismatch", async (marketClient) => {
        await prepareExpandedLegacyFixture(marketClient);
        await seedOtherOwnershipRoot(marketClient);
        await marketClient.query(`
          UPDATE "ContentAsset"
          SET
            "clientId" = 'client_other',
            "brandId" = 'brand_other',
            "siteId" = 'site_other_com',
            "siteMarketId" = 'site_market_other_my_en'
          WHERE "id" = 'asset_txpuro_zh';

          UPDATE "ChannelVariant"
          SET "siteMarketId" = 'site_market_txpuro_my_zh_cn'
          WHERE "id" = 'variant_txpuro';
        `);

        await expectPgError(
          () => applyMigration(marketClient, backfillMigrationPath),
          "P0001",
          /ownership chain after backfill.*ChannelVariant.*variant_txpuro/i,
        );
        const fixedRoot = await marketClient.query(`
          SELECT count(*)::int AS count
          FROM "Workspace" WHERE "id" = 'workspace_internal'
        `);
        expect(fixedRoot.rows[0]?.count).toBe(0);
      });
    });

    it("accepts normalized Txpuro brand aliases and valid URL port boundaries", async () => {
      await withFreshSchema("safe_signals", async (safeClient) => {
        await applyLegacyMigrations(safeClient);
        await seedLegacyContentProbe(safeClient, {
          id: "asset_alias_short",
          brandEntity: "  TXPURO  ",
          sourceUrl: "http://geo-origin.winghengtech.com:1/guides/en/short",
          canonicalUrl: "https://www.txpuro.com:443/guides/en/short",
        });
        await seedLegacyContentProbe(safeClient, {
          id: "asset_alias_english",
          brandEntity: " Txpuro   E-Invoice   System ",
          sourceUrl:
            "https://geo-origin.winghengtech.com:65535/guides/en/english",
          canonicalUrl: "https://txpuro.com/guides/en/english",
        });
        await seedLegacyContentProbe(safeClient, {
          id: "asset_alias_chinese",
          brandEntity: " 智慧电子发票系统   Txpuro ",
          sourceUrl:
            "https://geo-origin.winghengtech.com/guides/zh-CN/chinese",
          canonicalUrl: "http://txpuro.com:1/guides/zh-CN/chinese",
          locale: "zh-CN",
        });
        await safeClient.query(`
          INSERT INTO "SeoAudit" (
            "id", "url", "score", "issues", "auditedAt"
          ) VALUES (
            'seo_port_65535',
            'https://txpuro.com:65535/guides/en/technical-audit',
            1, '[]'::jsonb, CURRENT_TIMESTAMP
          );
          INSERT INTO "KeywordRanking" (
            "id", "keyword", "url", "position", "source", "recordedAt"
          ) VALUES (
            'ranking_port_443', 'txpuro',
            'http://geo-origin.winghengtech.com:443/guides/en/ranking',
            1, 'test', CURRENT_TIMESTAMP
          );
        `);
        const beforeSignals = await snapshotUrls(safeClient);

        await applyMigration(safeClient, expandMigrationPath);
        await applyMigration(safeClient, backfillMigrationPath);

        const owned = await safeClient.query(`
          SELECT "id", "brandEntity", "clientId", "brandId", "siteId"
          FROM "ContentAsset" ORDER BY "id"
        `);
        expect(owned.rows).toEqual([
          {
            id: "asset_alias_chinese",
            brandEntity: " 智慧电子发票系统   Txpuro ",
            clientId: fixedOwnership.clientId,
            brandId: fixedOwnership.brandId,
            siteId: fixedOwnership.siteId,
          },
          {
            id: "asset_alias_english",
            brandEntity: " Txpuro   E-Invoice   System ",
            clientId: fixedOwnership.clientId,
            brandId: fixedOwnership.brandId,
            siteId: fixedOwnership.siteId,
          },
          {
            id: "asset_alias_short",
            brandEntity: "  TXPURO  ",
            clientId: fixedOwnership.clientId,
            brandId: fixedOwnership.brandId,
            siteId: fixedOwnership.siteId,
          },
        ]);
        expect(await snapshotUrls(safeClient)).toEqual(beforeSignals);
      });
    });

    it("rejects a contradictory explicit brand signal with Txpuro URLs", async () => {
      await withFreshSchema("unsafe_brand", async (unsafeClient) => {
        await applyLegacyMigrations(unsafeClient);
        await seedLegacyContentProbe(unsafeClient, {
          id: "asset_aurora_txpuro_urls",
          brandEntity: "Aurora",
          sourceUrl:
            "https://geo-origin.winghengtech.com/guides/en/aurora-signal",
          canonicalUrl: "https://txpuro.com/guides/en/aurora-signal",
        });
        await applyMigration(unsafeClient, expandMigrationPath);

        await expectPgError(
          () => applyMigration(unsafeClient, backfillMigrationPath),
          "P0001",
          /unsafe ContentAsset brand signal.*asset_aurora_txpuro_urls/i,
        );
        const roots = await unsafeClient.query(`
          SELECT count(*)::int AS count FROM "Workspace"
        `);
        expect(roots.rows[0]?.count).toBe(0);
      });
    });

    it("rejects zero and out-of-range URL ports in every safety source", async () => {
      const cases: Array<
        | {
            label: string;
            source: "content";
            port: number;
            field: "canonicalUrl" | "sourceUrl";
          }
        | {
            label: string;
            source: "seo" | "ranking";
            port: number;
          }
      > = [
        {
          label: "content_canonical_99999",
          source: "content",
          port: 99999,
          field: "canonicalUrl",
        },
        {
          label: "content_source_0",
          source: "content",
          port: 0,
          field: "sourceUrl",
        },
        { label: "seo_65536", source: "seo", port: 65536 },
        { label: "ranking_99999", source: "ranking", port: 99999 },
      ];

      for (const unsafeCase of cases) {
        await withFreshSchema(unsafeCase.label, async (unsafeClient) => {
          await applyLegacyMigrations(unsafeClient);
          if (unsafeCase.source === "content") {
            const unsafeUrl = `https://txpuro.com:${unsafeCase.port}/guides/en/port`;
            await seedLegacyContentProbe(unsafeClient, {
              id: `asset_${unsafeCase.label}`,
              brandEntity: "Txpuro",
              sourceUrl:
                unsafeCase.field === "sourceUrl"
                  ? unsafeUrl
                  : "https://geo-origin.winghengtech.com/guides/en/port",
              canonicalUrl:
                unsafeCase.field === "canonicalUrl"
                  ? unsafeUrl
                  : "https://txpuro.com/guides/en/port",
            });
          } else if (unsafeCase.source === "seo") {
            await unsafeClient.query(
              `
                INSERT INTO "SeoAudit" (
                  "id", "url", "score", "issues", "auditedAt"
                ) VALUES (
                  'seo_invalid_port', $1, 1, '[]'::jsonb, CURRENT_TIMESTAMP
                )
              `,
              [`https://txpuro.com:${unsafeCase.port}/guides/en/audit`],
            );
          } else {
            await unsafeClient.query(
              `
                INSERT INTO "KeywordRanking" (
                  "id", "keyword", "url", "position", "source", "recordedAt"
                ) VALUES (
                  'ranking_invalid_port', 'txpuro', $1, 1, 'test',
                  CURRENT_TIMESTAMP
                )
              `,
              [`https://txpuro.com:${unsafeCase.port}/guides/en/ranking`],
            );
          }

          await applyMigration(unsafeClient, expandMigrationPath);
          await expectPgError(
            () => applyMigration(unsafeClient, backfillMigrationPath),
            "P0001",
            /unsafe Txpuro URL/i,
          );
          const roots = await unsafeClient.query(`
            SELECT count(*)::int AS count FROM "Workspace"
          `);
          expect(roots.rows[0]?.count, unsafeCase.label).toBe(0);
        });
      }
    });

    it.each<FixedRootConflict>([
      "inactive_client",
      "inactive_site",
      "wrong_site_name",
      "wrong_market_settings",
    ])("rejects conflicting fixed ownership data: %s", async (conflict) => {
      await withFreshSchema(`fixed_${conflict}`, async (conflictClient) => {
        await applyLegacyMigrations(conflictClient);
        await applyMigration(conflictClient, expandMigrationPath);
        await seedConflictingFixedRoot(conflictClient, conflict);

        await expectPgError(
          () => applyMigration(conflictClient, backfillMigrationPath),
          "P0001",
          /fixed ownership conflict/i,
        );
        const preserved = await conflictClient.query(`
          SELECT
            (SELECT count(*)::int FROM "Workspace") AS workspaces,
            (SELECT count(*)::int FROM "SiteMarket") AS markets
        `);
        expect(preserved.rows[0]).toEqual({ workspaces: 1, markets: 2 });
      });
    });

    it("rejects malformed or non-Txpuro URL-only and content rows", async () => {
      await withFreshSchema("unsafe_content", async (unsafeClient) => {
        await applyLegacyMigrations(unsafeClient);
        await unsafeClient.query(`
          INSERT INTO "ContentAsset" (
            "id", "title", "body", "summary", "brandEntity", "sourceUrl",
            "targetKeywords", "canonicalUrl", "status", "owner", "slug",
            "locale", "assetType", "schemaType", "ctaMode", "publishTarget",
            "isPublic", "createdAt", "updatedAt"
          ) VALUES (
            'asset_aurora', 'Aurora', 'body', 'summary', 'Txpuro',
            'https://aurora.example/guides/demo', ARRAY['aurora'],
            'https://aurora.example/guides/demo', 'Ready', 'legacy',
            'aurora', 'en', 'guide-page', 'article', 'self_signup',
            'geo_ops_internal', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          );
        `);
        await applyMigration(unsafeClient, expandMigrationPath);
        await expectPgError(
          () => applyMigration(unsafeClient, backfillMigrationPath),
          "P0001",
          /unsafe ContentAsset URL.*asset_aurora/i,
        );
        const roots = await unsafeClient.query(`
          SELECT count(*)::int AS count FROM "Workspace"
        `);
        expect(roots.rows[0]?.count).toBe(0);
      });

      await withFreshSchema("unsafe_seo", async (unsafeClient) => {
        await applyLegacyMigrations(unsafeClient);
        await unsafeClient.query(`
          INSERT INTO "SeoAudit" (
            "id", "url", "score", "issues", "auditedAt"
          ) VALUES (
            'seo_malformed', 'not a url', 1, '[]'::jsonb, CURRENT_TIMESTAMP
          )
        `);
        await applyMigration(unsafeClient, expandMigrationPath);
        await expectPgError(
          () => applyMigration(unsafeClient, backfillMigrationPath),
          "P0001",
          /unsafe SeoAudit URL.*seo_malformed/i,
        );
        const roots = await unsafeClient.query(`
          SELECT count(*)::int AS count FROM "Workspace"
        `);
        expect(roots.rows[0]?.count).toBe(0);
      });

      await withFreshSchema("unsafe_ranking", async (unsafeClient) => {
        await applyLegacyMigrations(unsafeClient);
        await unsafeClient.query(`
          INSERT INTO "KeywordRanking" (
            "id", "keyword", "url", "position", "source", "recordedAt"
          ) VALUES (
            'ranking_other', 'other', 'https://other.example/guides/en',
            1, 'test', CURRENT_TIMESTAMP
          )
        `);
        await applyMigration(unsafeClient, expandMigrationPath);
        await expectPgError(
          () => applyMigration(unsafeClient, backfillMigrationPath),
          "P0001",
          /unsafe KeywordRanking URL.*ranking_other/i,
        );
        const roots = await unsafeClient.query(`
          SELECT count(*)::int AS count FROM "Workspace"
        `);
        expect(roots.rows[0]?.count).toBe(0);
      });
    });

    it("accepts every valid legacy relationship in an independent backfill", async () => {
      await withFreshSchema("backfill_relationships_positive", async (target) => {
        await prepareExpandedLegacyFixture(target);
        await applyMigration(target, backfillMigrationPath);
        await applyMigration(target, enforceMigrationPath);

        const owned = await target.query(`
          SELECT count(*)::int AS count
          FROM (
            SELECT "id" FROM "ContentAsset" WHERE "trendTopicId" IS NOT NULL
            UNION ALL
            SELECT "id" FROM "GeoRun" WHERE "contentAssetId" IS NOT NULL
            UNION ALL
            SELECT "id" FROM "ChannelVariant"
            UNION ALL
            SELECT "id" FROM "GeoFlowTaskLink"
            UNION ALL
            SELECT "id" FROM "VariantMetric"
            UNION ALL
            SELECT "id" FROM "ExportPackage"
            UNION ALL
            SELECT "id" FROM "DistributionDispatch"
            UNION ALL
            SELECT "id" FROM "AuditEvent" WHERE "entityId" IS NOT NULL
            UNION ALL
            SELECT "id" FROM "EventDelivery" WHERE "entityId" IS NOT NULL
          ) relationships
        `);
        expect(owned.rows[0]?.count).toBe(9);
      });
    });

    it.each(backfillRelationshipCases)(
      "rejects $label mismatch before backfill commits",
      async ({ label, mutation }) => {
        await withFreshSchema(
          `backfill_relation_${label.replaceAll(/[^a-zA-Z0-9]/g, "_")}`,
          async (target) => {
            await prepareExpandedLegacyFixture(target);
            await target.query(mutation);

            await expectPgError(
              () => applyMigration(target, backfillMigrationPath),
              "P0001",
              /legacy relationship ownership mismatch/i,
            );
            const roots = await target.query(`
              SELECT count(*)::int AS count FROM "Workspace"
            `);
            expect(roots.rows[0]?.count).toBe(0);
          },
        );
      },
    );

    it.each(polymorphicSiteLevelBackfillRejectCases)(
      "rejects $label before backfill commits",
      async ({ label, table, rowId, mutation, message }) => {
        await withFreshSchema(
          `backfill_poly_scope_${label.replaceAll(/[^a-zA-Z0-9]/g, "_")}`,
          async (target) => {
            await prepareExpandedLegacyFixture(target);
            await target.query(mutation);

            await expectPgError(
              () => applyMigration(target, backfillMigrationPath),
              "P0001",
              message,
            );
            const roots = await target.query(`
              SELECT count(*)::int AS count FROM "Workspace"
            `);
            expect(roots.rows[0]?.count).toBe(0);
            const preserved = await target.query(
              `
                SELECT "siteMarketId"
                FROM ${quoteIdentifier(table)}
                WHERE "id" = $1
              `,
              [rowId],
            );
            expect(preserved.rows[0]?.siteMarketId).toBe(
              fixedOwnership.zhMarketId,
            );
          },
        );
      },
    );

    it.each(polymorphicExactMarketBackfillRejectCases)(
      "rejects polymorphic $label before backfill commits",
      async ({ label, mutation }) => {
        await withFreshSchema(
          `backfill_poly_exact_${label.replaceAll(/[^a-zA-Z0-9]/g, "_")}`,
          async (target) => {
            await prepareExpandedLegacyFixture(target);
            await target.query(mutation);

            await expectPgError(
              () => applyMigration(target, backfillMigrationPath),
              "P0001",
              /legacy relationship ownership mismatch.*AuditEvent/i,
            );
            const roots = await target.query(`
              SELECT count(*)::int AS count FROM "Workspace"
            `);
            expect(roots.rows[0]?.count).toBe(0);
          },
        );
      },
    );

    it("normalizes every legacy polymorphic alias and inherits the exact parent market", async () => {
      await withFreshSchema("backfill_poly_aliases", async (target) => {
        await prepareExpandedLegacyFixture(target);
        await target.query(`
          UPDATE "EventDelivery"
          SET "siteMarketId" = 'site_market_txpuro_my_zh_cn'
          WHERE "id" = 'delivery_txpuro'
        `);

        for (const [table, parentId, entityType] of polymorphicParents) {
          if (table === "AuditEvent") {
            await cloneEventDelivery(target, {
              id: `delivery_backfill_alias_${table}`,
              entityType,
              entityId: parentId,
              siteMarketId: null,
            });
          } else {
            await cloneAuditEvent(target, {
              id: `audit_backfill_alias_${table}`,
              entityType,
              entityId: parentId,
              siteMarketId: null,
            });
          }
        }

        await applyMigration(target, backfillMigrationPath);
        await applyMigration(target, enforceMigrationPath);

        for (const [table, parentId] of polymorphicParents) {
          const childTable =
            table === "AuditEvent" ? "EventDelivery" : "AuditEvent";
          const childId =
            table === "AuditEvent"
              ? `delivery_backfill_alias_${table}`
              : `audit_backfill_alias_${table}`;
          const scopes = await target.query(
            `
              SELECT "clientId", "brandId", "siteId", "siteMarketId"
              FROM ${quoteIdentifier(table)}
              WHERE "id" = $1
              UNION ALL
              SELECT "clientId", "brandId", "siteId", "siteMarketId"
              FROM ${quoteIdentifier(childTable)}
              WHERE "id" = $2
            `,
            [parentId, childId],
          );
          expect(scopes.rows, `${table} normalized alias`).toHaveLength(2);
          expect(scopes.rows[1], `${table} exact inherited scope`).toEqual(
            scopes.rows[0],
          );
        }
      });
    });

    it("converges AuditEvent to EventDelivery to an anchored SeoAudit market", async () => {
      await withFreshSchema("backfill_poly_audit_delivery_anchor", async (target) => {
        await prepareExpandedLegacyFixture(target);
        await target.query(`
          UPDATE "AuditEvent"
          SET
            "entityType" = 'event-deliveries',
            "entityId" = 'delivery_txpuro',
            "siteMarketId" = NULL
          WHERE "id" = 'audit_txpuro';

          UPDATE "EventDelivery"
          SET
            "entityType" = 'seo_audits',
            "entityId" = 'seo_audit_txpuro',
            "siteMarketId" = NULL
          WHERE "id" = 'delivery_txpuro';
        `);

        await applyMigration(target, backfillMigrationPath);
        await applyMigration(target, enforceMigrationPath);

        const scopes = await target.query(`
          SELECT 'AuditEvent' AS source, "clientId", "brandId", "siteId",
            "siteMarketId"
          FROM "AuditEvent" WHERE "id" = 'audit_txpuro'
          UNION ALL
          SELECT 'EventDelivery', "clientId", "brandId", "siteId",
            "siteMarketId"
          FROM "EventDelivery" WHERE "id" = 'delivery_txpuro'
          ORDER BY source
        `);
        expect(scopes.rows).toEqual([
          {
            source: "AuditEvent",
            clientId: fixedOwnership.clientId,
            brandId: fixedOwnership.brandId,
            siteId: fixedOwnership.siteId,
            siteMarketId: fixedOwnership.enMarketId,
          },
          {
            source: "EventDelivery",
            clientId: fixedOwnership.clientId,
            brandId: fixedOwnership.brandId,
            siteId: fixedOwnership.siteId,
            siteMarketId: fixedOwnership.enMarketId,
          },
        ]);
      });
    });

    it("converges EventDelivery to AuditEvent to an anchored SeoAudit market", async () => {
      await withFreshSchema("backfill_poly_delivery_audit_anchor", async (target) => {
        await prepareExpandedLegacyFixture(target);
        await target.query(`
          UPDATE "AuditEvent"
          SET
            "entityType" = 'SEO_AUDITS',
            "entityId" = 'seo_audit_txpuro',
            "siteMarketId" = NULL
          WHERE "id" = 'audit_txpuro';

          UPDATE "EventDelivery"
          SET
            "entityType" = 'audit-events',
            "entityId" = 'audit_txpuro',
            "siteMarketId" = NULL
          WHERE "id" = 'delivery_txpuro';
        `);

        await applyMigration(target, backfillMigrationPath);
        await applyMigration(target, enforceMigrationPath);

        const scopes = await target.query(`
          SELECT 'AuditEvent' AS source, "siteMarketId"
          FROM "AuditEvent" WHERE "id" = 'audit_txpuro'
          UNION ALL
          SELECT 'EventDelivery', "siteMarketId"
          FROM "EventDelivery" WHERE "id" = 'delivery_txpuro'
          ORDER BY source
        `);
        expect(scopes.rows).toEqual([
          {
            source: "AuditEvent",
            siteMarketId: fixedOwnership.enMarketId,
          },
          {
            source: "EventDelivery",
            siteMarketId: fixedOwnership.enMarketId,
          },
        ]);
      });
    });

    it("converges a three-hop alternating polymorphic chain", async () => {
      await withFreshSchema("backfill_poly_long_chain", async (target) => {
        await prepareExpandedLegacyFixture(target);
        await cloneAuditEvent(target, {
          id: "audit_chain_middle",
          entityType: "event_deliveries",
          entityId: "delivery_txpuro",
          siteMarketId: null,
        });
        await cloneEventDelivery(target, {
          id: "delivery_chain_middle",
          entityType: "audit-events",
          entityId: "audit_chain_middle",
          siteMarketId: null,
        });
        await target.query(`
          UPDATE "AuditEvent"
          SET
            "entityType" = 'event-deliveries',
            "entityId" = 'delivery_chain_middle',
            "siteMarketId" = NULL
          WHERE "id" = 'audit_txpuro';

          UPDATE "EventDelivery"
          SET
            "entityType" = 'seo-audits',
            "entityId" = 'seo_audit_txpuro',
            "siteMarketId" = NULL
          WHERE "id" = 'delivery_txpuro';
        `);

        await applyMigration(target, backfillMigrationPath);
        await applyMigration(target, enforceMigrationPath);

        const scopes = await target.query(`
          SELECT "siteMarketId"
          FROM "AuditEvent"
          WHERE "id" IN ('audit_txpuro', 'audit_chain_middle')
          UNION ALL
          SELECT "siteMarketId"
          FROM "EventDelivery"
          WHERE "id" IN ('delivery_txpuro', 'delivery_chain_middle')
        `);
        expect(scopes.rows).toHaveLength(4);
        expect(
          scopes.rows.every(
            (scope) => scope.siteMarketId === fixedOwnership.enMarketId,
          ),
        ).toBe(true);
      });
    });

    it("propagates through a cycle with an existing ownership anchor", async () => {
      await withFreshSchema("backfill_poly_anchored_cycle", async (target) => {
        await prepareExpandedLegacyFixture(target);
        await target.query(`
          UPDATE "AuditEvent"
          SET
            "clientId" = 'client_wing_heng',
            "brandId" = 'brand_txpuro',
            "siteId" = 'site_txpuro_com',
            "siteMarketId" = 'site_market_txpuro_my_en',
            "entityType" = 'event-deliveries',
            "entityId" = 'delivery_txpuro'
          WHERE "id" = 'audit_txpuro';

          UPDATE "EventDelivery"
          SET
            "entityType" = 'audit_events',
            "entityId" = 'audit_txpuro',
            "siteMarketId" = NULL
          WHERE "id" = 'delivery_txpuro';
        `);

        await applyMigration(target, backfillMigrationPath);
        await applyMigration(target, enforceMigrationPath);

        const delivery = await target.query(`
          SELECT "clientId", "brandId", "siteId", "siteMarketId"
          FROM "EventDelivery" WHERE "id" = 'delivery_txpuro'
        `);
        expect(delivery.rows[0]).toEqual({
          clientId: fixedOwnership.clientId,
          brandId: fixedOwnership.brandId,
          siteId: fixedOwnership.siteId,
          siteMarketId: fixedOwnership.enMarketId,
        });
      });
    });

    it("falls back an unanchored polymorphic cycle to site-level ownership", async () => {
      await withFreshSchema("backfill_poly_unanchored_cycle", async (target) => {
        await prepareExpandedLegacyFixture(target);
        await target.query(`
          UPDATE "AuditEvent"
          SET
            "entityType" = 'event-deliveries',
            "entityId" = 'delivery_txpuro',
            "siteMarketId" = NULL
          WHERE "id" = 'audit_txpuro';

          UPDATE "EventDelivery"
          SET
            "entityType" = 'audit_events',
            "entityId" = 'audit_txpuro',
            "siteMarketId" = NULL
          WHERE "id" = 'delivery_txpuro';
        `);

        await applyMigration(target, backfillMigrationPath);
        await applyMigration(target, enforceMigrationPath);

        const scopes = await target.query(`
          SELECT "clientId", "brandId", "siteId", "siteMarketId"
          FROM "AuditEvent" WHERE "id" = 'audit_txpuro'
          UNION ALL
          SELECT "clientId", "brandId", "siteId", "siteMarketId"
          FROM "EventDelivery" WHERE "id" = 'delivery_txpuro'
        `);
        expect(scopes.rows).toHaveLength(2);
        expect(scopes.rows).toEqual([
          {
            clientId: fixedOwnership.clientId,
            brandId: fixedOwnership.brandId,
            siteId: fixedOwnership.siteId,
            siteMarketId: null,
          },
          {
            clientId: fixedOwnership.clientId,
            brandId: fixedOwnership.brandId,
            siteId: fixedOwnership.siteId,
            siteMarketId: null,
          },
        ]);
      });
    });

    it("rolls back a converged chain with a contradictory existing market", async () => {
      await withFreshSchema("backfill_poly_chain_market_conflict", async (target) => {
        await prepareExpandedLegacyFixture(target);
        await target.query(`
          UPDATE "AuditEvent"
          SET
            "entityType" = 'event-deliveries',
            "entityId" = 'delivery_txpuro',
            "siteMarketId" = 'site_market_txpuro_my_zh_cn'
          WHERE "id" = 'audit_txpuro';

          UPDATE "EventDelivery"
          SET
            "entityType" = 'seo-audits',
            "entityId" = 'seo_audit_txpuro',
            "siteMarketId" = NULL
          WHERE "id" = 'delivery_txpuro';
        `);

        await expectPgError(
          () => applyMigration(target, backfillMigrationPath),
          "P0001",
          /legacy relationship ownership mismatch.*AuditEvent.*EventDelivery/i,
        );
        const roots = await target.query(`
          SELECT count(*)::int AS count FROM "Workspace"
        `);
        expect(roots.rows[0]?.count).toBe(0);
      });
    });

    it("rolls back a missing known polymorphic parent after convergence", async () => {
      await withFreshSchema("backfill_poly_missing_parent", async (target) => {
        await prepareExpandedLegacyFixture(target);
        await target.query(`
          UPDATE "AuditEvent"
          SET
            "entityType" = 'content-assets',
            "entityId" = 'asset_missing',
            "siteMarketId" = NULL
          WHERE "id" = 'audit_txpuro'
        `);

        await expectPgError(
          () => applyMigration(target, backfillMigrationPath),
          "P0001",
          /legacy polymorphic parent missing.*AuditEvent.*ContentAsset.*asset_missing/i,
        );
        const roots = await target.query(`
          SELECT count(*)::int AS count FROM "Workspace"
        `);
        expect(roots.rows[0]?.count).toBe(0);
      });
    });

    it("backfills site-level polymorphic provenance without inventing a market", async () => {
      await withFreshSchema("backfill_poly_site_level", async (target) => {
        await prepareExpandedLegacyFixture(target);
        await target.query(`
          UPDATE "AuditEvent"
          SET
            "entityType" = 'ContentAsset',
            "entityId" = NULL,
            "siteMarketId" = NULL
          WHERE "id" = 'audit_txpuro';

          UPDATE "EventDelivery"
          SET
            "entityType" = 'Workspace',
            "entityId" = 'workspace_internal',
            "siteMarketId" = NULL
          WHERE "id" = 'delivery_txpuro';
        `);

        await applyMigration(target, backfillMigrationPath);
        await applyMigration(target, enforceMigrationPath);

        const scopes = await target.query(`
          SELECT
            'AuditEvent' AS "tableName",
            "entityType",
            "entityId",
            "clientId",
            "brandId",
            "siteId",
            "siteMarketId"
          FROM "AuditEvent"
          WHERE "id" = 'audit_txpuro'
          UNION ALL
          SELECT
            'EventDelivery',
            "entityType",
            "entityId",
            "clientId",
            "brandId",
            "siteId",
            "siteMarketId"
          FROM "EventDelivery"
          WHERE "id" = 'delivery_txpuro'
          ORDER BY "tableName"
        `);
        expect(scopes.rows).toEqual([
          {
            tableName: "AuditEvent",
            entityType: "ContentAsset",
            entityId: null,
            clientId: fixedOwnership.clientId,
            brandId: fixedOwnership.brandId,
            siteId: fixedOwnership.siteId,
            siteMarketId: null,
          },
          {
            tableName: "EventDelivery",
            entityType: "Workspace",
            entityId: "workspace_internal",
            clientId: fixedOwnership.clientId,
            brandId: fixedOwnership.brandId,
            siteId: fixedOwnership.siteId,
            siteMarketId: null,
          },
        ]);
      });
    });

    it("blocks legacy writes between backfill and successful enforce", async () => {
      await withFreshSchema("write_gate_lifecycle", async (target) => {
        await prepareBackfilledFreshSchema(target);

        const installed = await target.query<{
          dmlTriggers: number;
          truncateTriggers: number;
        }>(`
          SELECT
            count(*) FILTER (
              WHERE tgname LIKE 'ownership_backfill_write_gate_%'
            )::int AS "dmlTriggers",
            count(*) FILTER (
              WHERE tgname LIKE 'ownership_backfill_truncate_gate_%'
            )::int AS "truncateTriggers"
          FROM pg_trigger
          WHERE NOT tgisinternal
        `);
        expect(installed.rows[0]).toEqual({
          dmlTriggers: legacyTables.length,
          truncateTriggers: legacyTables.length,
        });
        await expectPgError(
          () =>
            target.query(`
              INSERT INTO "GeoFlowSyncRun" ("id")
              VALUES ('write_during_migration_gap')
            `),
          "55000",
          /ownership migration write gate.*GeoFlowSyncRun/i,
        );
        await expectPgError(
          () => target.query(`TRUNCATE "GeoFlowSyncRun"`),
          "55000",
          /ownership migration write gate.*GeoFlowSyncRun/i,
        );

        await applyMigration(target, enforceMigrationPath);
        const removed = await target.query<{
          dmlTriggers: number;
          truncateTriggers: number;
          functions: number;
        }>(`
          SELECT
            (
              SELECT count(*)::int
              FROM pg_trigger
              WHERE NOT tgisinternal
                AND tgname LIKE 'ownership_backfill_write_gate_%'
            ) AS "dmlTriggers",
            (
              SELECT count(*)::int
              FROM pg_trigger
              WHERE NOT tgisinternal
                AND tgname LIKE 'ownership_backfill_truncate_gate_%'
            ) AS "truncateTriggers",
            (
              SELECT count(*)::int
              FROM pg_proc
              WHERE pronamespace = current_schema()::regnamespace
                AND proname = 'block_legacy_writes_until_enforced'
            ) AS functions
        `);
        expect(removed.rows[0]).toEqual({
          dmlTriggers: 0,
          truncateTriggers: 0,
          functions: 0,
        });

        await target.query(`
          INSERT INTO "GeoFlowSyncRun" (
            "id", "clientId", "brandId", "siteId"
          )
          VALUES (
            'write_after_enforce', 'client_wing_heng',
            'brand_txpuro', 'site_txpuro_com'
          )
        `);
      });
    });

    it("keeps the committed write gate when enforce rolls back", async () => {
      await withFreshSchema("write_gate_enforce_failure", async (target) => {
        await prepareBackfilledFreshSchema(target);
        await seedOtherOwnershipRoot(target);
        await target.query(`
          INSERT INTO "AnalysisRun" (
            "id", "clientId", "brandId", "siteId", "siteMarketId",
            "kind", "source", "sourceVersion", "adapterVersion", "status",
            "inputHash", "idempotencyKey", "trigger"
          ) VALUES (
            'analysis_invalid_before_enforce',
            'client_wing_heng', 'brand_other', 'site_other_com',
            'site_market_other_my_en', 'audit', 'test', '1', '1',
            'queued', 'invalid-input', 'invalid-enforce', 'manual'
          )
        `);

        await expectPgError(
          () => applyMigration(target, enforceMigrationPath),
          "23514",
          /tenant ownership mismatch.*AnalysisRun/i,
        );
        const installed = await target.query<{
          dmlTriggers: number;
          truncateTriggers: number;
        }>(`
          SELECT
            count(*) FILTER (
              WHERE tgname LIKE 'ownership_backfill_write_gate_%'
            )::int AS "dmlTriggers",
            count(*) FILTER (
              WHERE tgname LIKE 'ownership_backfill_truncate_gate_%'
            )::int AS "truncateTriggers"
          FROM pg_trigger
          WHERE NOT tgisinternal
        `);
        expect(installed.rows[0]).toEqual({
          dmlTriggers: legacyTables.length,
          truncateTriggers: legacyTables.length,
        });
        await expectPgError(
          () =>
            target.query(`
              DELETE FROM "GeoFlowSyncRun" WHERE "id" = 'sync_txpuro'
            `),
          "55000",
          /ownership migration write gate.*GeoFlowSyncRun/i,
        );
        await expectPgError(
          () => target.query(`TRUNCATE "GeoFlowSyncRun"`),
          "55000",
          /ownership migration write gate.*GeoFlowSyncRun/i,
        );
      });
    });

    it("serializes a concurrent evil insert across scan, backfill, and gate", async () => {
      await withFreshSchema("write_gate_concurrency", async (target, schema) => {
        await prepareExpandedLegacyFixture(target);
        const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
        const backfillApp = `sgeo-task4-backfill-${suffix}`;
        const writerApp = `sgeo-task4-writer-${suffix}`;
        const backfillClient = await openSchemaClient(schema, backfillApp);
        const writerClient = await openSchemaClient(schema, writerApp);
        const advisoryKey = Math.floor(Math.random() * 1_000_000_000);
        let advisoryHeld = false;

        try {
          await target.query("SELECT pg_advisory_lock($1)", [advisoryKey]);
          advisoryHeld = true;
          const backfillSql = await readFile(resolve(backfillMigrationPath), "utf8");
          const pausedBackfillSql = backfillSql.replace(
            'UPDATE "SeoAudit"\nSET',
            `SELECT pg_advisory_lock(${advisoryKey});
             SELECT pg_advisory_unlock(${advisoryKey});

             UPDATE "SeoAudit"
             SET`,
          );
          expect(pausedBackfillSql).not.toBe(backfillSql);

          const backfillResult = backfillClient
            .query(pausedBackfillSql)
            .then(() => ({ error: undefined }))
            .catch((error: PgError) => ({ error }));
          const reachedPostScanPause = await waitForPgCondition(
            target,
            `
              SELECT EXISTS (
                SELECT 1
                FROM pg_stat_activity
                WHERE application_name = $1
                  AND wait_event_type = 'Lock'
                  AND wait_event = 'advisory'
              ) AS matched
            `,
            [backfillApp],
          );
          expect(reachedPostScanPause).toBe(true);

          const writerResult = writerClient
            .query(`
              INSERT INTO "SeoAudit" (
                "id", "url", "score", "issues", "auditedAt"
              ) VALUES (
                'seo_concurrent_evil',
                'https://evil.example/guides/en/race',
                1, '[]'::jsonb, CURRENT_TIMESTAMP
              )
            `)
            .then(() => ({ error: undefined }))
            .catch((error: PgError) => ({ error }));
          const writerBlocked = await waitForPgCondition(
            target,
            `
              SELECT EXISTS (
                SELECT 1
                FROM pg_stat_activity
                WHERE application_name = $1
                  AND wait_event_type = 'Lock'
              ) AS matched
            `,
            [writerApp],
            1_000,
          );

          await target.query("SELECT pg_advisory_unlock($1)", [advisoryKey]);
          advisoryHeld = false;
          const [backfillOutcome, writerOutcome] = await Promise.all([
            backfillResult,
            writerResult,
          ]);
          expect(writerBlocked).toBe(true);
          expect(backfillOutcome.error).toBeUndefined();
          expect(writerOutcome.error?.code).toBe("55000");
          expect(writerOutcome.error?.message).toMatch(
            /ownership migration write gate.*SeoAudit/i,
          );

          const evil = await target.query(`
            SELECT count(*)::int AS count
            FROM "SeoAudit" WHERE "id" = 'seo_concurrent_evil'
          `);
          expect(evil.rows[0]?.count).toBe(0);
        } finally {
          if (advisoryHeld) {
            await target
              .query("SELECT pg_advisory_unlock($1)", [advisoryKey])
              .catch(() => undefined);
          }
          await Promise.allSettled([
            backfillClient.query("ROLLBACK"),
            writerClient.query("ROLLBACK"),
          ]);
          await Promise.all([backfillClient.end(), writerClient.end()]);
        }
      });
    });

    it("resolves all legacy polymorphic parent names and permits unknown types", async () => {
      await withFreshSchema("polymorphic_types", async (target) => {
        await prepareEnforcedFreshSchema(target);

        for (const [table, parentId, entityType] of polymorphicParents) {
          const parent = await target.query<{
            clientId: string;
            brandId: string;
            siteId: string;
            siteMarketId: string | null;
          }>(
            `
              SELECT "clientId", "brandId", "siteId", "siteMarketId"
              FROM ${quoteIdentifier(table)}
              WHERE "id" = $1
            `,
            [parentId],
          );
          expect(parent.rows[0], `${table} parent fixture`).toBeDefined();
          await cloneAuditEvent(target, {
            id: `audit_poly_${table}`,
            entityType,
            entityId: parentId,
            ...parent.rows[0],
          });
        }

        await seedOtherOwnershipRoot(target);
        await cloneAuditEvent(target, {
          id: "audit_unknown_type",
          entityType: "GeoBrief",
          entityId: "brief_without_table",
          clientId: "client_other",
          brandId: "brand_other",
          siteId: "site_other_com",
          siteMarketId: null,
        });
        await cloneEventDelivery(target, {
          id: "delivery_unknown_type",
          entityType: "Workspace",
          entityId: "workspace_other",
          clientId: "client_other",
          brandId: "brand_other",
          siteId: "site_other_com",
          siteMarketId: null,
        });

        const catalog = await target.query<{
          child_triggers: number;
          parent_update_triggers: number;
          parent_delete_triggers: number;
          parent_truncate_triggers: number;
          reverse_indexes: number;
        }>(`
          SELECT
            (
              SELECT count(*)::int FROM pg_trigger
              WHERE NOT tgisinternal
                AND tgname LIKE 'ownership_poly_child_%'
                AND tgrelid IN (
                  SELECT format('%I.%I', current_schema(), table_name)::regclass
                  FROM information_schema.tables
                  WHERE table_schema = current_schema()
                )
            ) AS child_triggers,
            (
              SELECT count(*)::int FROM pg_trigger
              WHERE NOT tgisinternal
                AND tgname LIKE 'ownership_poly_parent_update_%'
                AND tgrelid IN (
                  SELECT format('%I.%I', current_schema(), table_name)::regclass
                  FROM information_schema.tables
                  WHERE table_schema = current_schema()
                )
            ) AS parent_update_triggers,
            (
              SELECT count(*)::int FROM pg_trigger
              WHERE NOT tgisinternal
                AND tgname LIKE 'ownership_poly_parent_delete_%'
                AND tgrelid IN (
                  SELECT format('%I.%I', current_schema(), table_name)::regclass
                  FROM information_schema.tables
                  WHERE table_schema = current_schema()
                )
            ) AS parent_delete_triggers,
            (
              SELECT count(*)::int FROM pg_trigger
              WHERE NOT tgisinternal
                AND tgname LIKE 'ownership_poly_parent_truncate_%'
                AND tgrelid IN (
                  SELECT format('%I.%I', current_schema(), table_name)::regclass
                  FROM information_schema.tables
                  WHERE table_schema = current_schema()
                )
            ) AS parent_truncate_triggers,
            (
              SELECT count(*)::int FROM pg_indexes
              WHERE schemaname = current_schema()
                AND indexname IN (
                  'AuditEvent_entityId_idx',
                  'EventDelivery_entityId_idx'
                )
            ) AS reverse_indexes
        `);
        expect(catalog.rows[0]).toEqual({
          child_triggers: 2,
          parent_update_triggers: legacyTables.length,
          parent_delete_triggers: legacyTables.length,
          parent_truncate_triggers: legacyTables.length,
          reverse_indexes: 2,
        });
      });
    });

    it("requires exact markets for known polymorphic parents", async () => {
      await withFreshSchema("polymorphic_exact_market", async (target) => {
        await prepareEnforcedFreshSchema(target);

        await cloneAuditEvent(target, {
          id: "audit_exact_zh",
          entityType: "content-assets",
          entityId: "asset_txpuro_zh",
          siteMarketId: fixedOwnership.zhMarketId,
        });
        await cloneAuditEvent(target, {
          id: "audit_exact_site_level",
          entityType: "geoflow_sync_runs",
          entityId: "sync_txpuro",
          siteMarketId: null,
        });

        await expectPgError(
          () =>
            cloneAuditEvent(target, {
              id: "audit_parent_zh_child_null",
              entityType: "CONTENT_ASSETS",
              entityId: "asset_txpuro_zh",
              siteMarketId: null,
            }),
          "23514",
          /polymorphic ownership mismatch.*AuditEvent.*ContentAsset/i,
        );
        await expectPgError(
          () =>
            cloneAuditEvent(target, {
              id: "audit_parent_null_child_zh",
              entityType: "geoflow-sync-runs",
              entityId: "sync_txpuro",
              siteMarketId: fixedOwnership.zhMarketId,
            }),
          "23514",
          /polymorphic ownership mismatch.*AuditEvent.*GeoFlowSyncRun/i,
        );
        await expectPgError(
          () =>
            cloneAuditEvent(target, {
              id: "audit_parent_zh_child_en",
              entityType: "content_assets",
              entityId: "asset_txpuro_zh",
              siteMarketId: fixedOwnership.enMarketId,
            }),
          "23514",
          /polymorphic ownership mismatch.*AuditEvent.*ContentAsset/i,
        );

        const exact = await target.query(`
          SELECT "id", "siteMarketId"
          FROM "AuditEvent"
          WHERE "id" IN ('audit_exact_zh', 'audit_exact_site_level')
          ORDER BY "id"
        `);
        expect(exact.rows).toEqual([
          {
            id: "audit_exact_site_level",
            siteMarketId: null,
          },
          {
            id: "audit_exact_zh",
            siteMarketId: fixedOwnership.zhMarketId,
          },
        ]);
      });
    });

    it("requires nullable polymorphic provenance to remain site-level", async () => {
      await withFreshSchema("polymorphic_site_level_scope", async (target) => {
        await prepareEnforcedFreshSchema(target);

        await cloneAuditEvent(target, {
          id: "audit_known_type_level",
          entityType: "ContentAsset",
          entityId: null,
          siteMarketId: null,
        });
        await cloneAuditEvent(target, {
          id: "audit_unknown_site_level",
          entityType: "GeoBrief",
          entityId: "brief_without_table",
          siteMarketId: null,
        });
        await cloneEventDelivery(target, {
          id: "delivery_unknown_site_level",
          entityType: "Workspace",
          entityId: "workspace_internal",
          siteMarketId: null,
        });

        await expectPgError(
          () =>
            cloneAuditEvent(target, {
              id: "audit_known_type_level_with_market",
              entityType: "ContentAsset",
              entityId: null,
              siteMarketId: fixedOwnership.zhMarketId,
            }),
          "23514",
          /type-level polymorphic audit requires NULL market.*AuditEvent/i,
        );
        await expectPgError(
          () =>
            cloneAuditEvent(target, {
              id: "audit_unknown_with_market",
              entityType: "GeoBrief",
              entityId: "brief_without_table",
              siteMarketId: fixedOwnership.zhMarketId,
            }),
          "23514",
          /site-level polymorphic provenance requires NULL market.*AuditEvent/i,
        );
        await expectPgError(
          () =>
            cloneEventDelivery(target, {
              id: "delivery_unknown_with_market",
              entityType: "Workspace",
              entityId: "workspace_internal",
              siteMarketId: fixedOwnership.zhMarketId,
            }),
          "23514",
          /site-level polymorphic provenance requires NULL market.*EventDelivery/i,
        );

        await expectPgError(
          () =>
            target.query(`
              UPDATE "AuditEvent"
              SET "siteMarketId" = 'site_market_txpuro_my_zh_cn'
              WHERE "id" = 'audit_known_type_level'
            `),
          "23514",
          /type-level polymorphic audit requires NULL market.*AuditEvent/i,
        );
        await expectPgError(
          () =>
            target.query(`
              UPDATE "AuditEvent"
              SET "siteMarketId" = 'site_market_txpuro_my_zh_cn'
              WHERE "id" = 'audit_unknown_site_level'
            `),
          "23514",
          /site-level polymorphic provenance requires NULL market.*AuditEvent/i,
        );
        await expectPgError(
          () =>
            target.query(`
              UPDATE "EventDelivery"
              SET "siteMarketId" = 'site_market_txpuro_my_zh_cn'
              WHERE "id" = 'delivery_unknown_site_level'
            `),
          "23514",
          /site-level polymorphic provenance requires NULL market.*EventDelivery/i,
        );

        const allowed = await target.query(`
          SELECT "id", "entityType", "entityId", "siteMarketId"
          FROM "AuditEvent"
          WHERE "id" IN (
            'audit_known_type_level',
            'audit_unknown_site_level'
          )
          UNION ALL
          SELECT "id", "entityType", "entityId", "siteMarketId"
          FROM "EventDelivery"
          WHERE "id" = 'delivery_unknown_site_level'
          ORDER BY "id"
        `);
        expect(allowed.rows).toEqual([
          {
            id: "audit_known_type_level",
            entityType: "ContentAsset",
            entityId: null,
            siteMarketId: null,
          },
          {
            id: "audit_unknown_site_level",
            entityType: "GeoBrief",
            entityId: "brief_without_table",
            siteMarketId: null,
          },
          {
            id: "delivery_unknown_site_level",
            entityType: "Workspace",
            entityId: "workspace_internal",
            siteMarketId: null,
          },
        ]);
      });
    });

    it("rejects polymorphic child inserts and updates with invalid provenance", async () => {
      await withFreshSchema("polymorphic_children", async (target) => {
        await prepareEnforcedFreshSchema(target);
        await seedOtherOwnershipRoot(target);

        await expectPgError(
          () =>
            cloneAuditEvent(target, {
              id: "audit_cross_tenant_parent",
              entityType: "content_assets",
              entityId: "asset_txpuro_zh",
              clientId: "client_other",
              brandId: "brand_other",
              siteId: "site_other_com",
              siteMarketId: "site_market_other_my_en",
            }),
          "23514",
          /polymorphic ownership mismatch.*AuditEvent.*ContentAsset/i,
        );
        await expectPgError(
          () =>
            cloneEventDelivery(target, {
              id: "delivery_cross_tenant_parent",
              entityType: "ContentAsset",
              entityId: "asset_txpuro_zh",
              clientId: "client_other",
              brandId: "brand_other",
              siteId: "site_other_com",
              siteMarketId: "site_market_other_my_en",
            }),
          "23514",
          /polymorphic ownership mismatch.*EventDelivery.*ContentAsset/i,
        );
        await expectPgError(
          () =>
            cloneAuditEvent(target, {
              id: "audit_missing_parent",
              entityType: "cOnTeNtAsSeT",
              entityId: "asset_missing",
            }),
          "23514",
          /polymorphic parent missing.*ContentAsset.*asset_missing/i,
        );
        await expectPgError(
          () =>
            cloneEventDelivery(target, {
              id: "delivery_missing_parent",
              entityType: "seo_audits",
              entityId: "seo_missing",
            }),
          "23514",
          /polymorphic parent missing.*SeoAudit.*seo_missing/i,
        );

        await cloneAuditEvent(target, {
          id: "audit_update_provenance",
          entityType: "ContentAsset",
          entityId: "asset_txpuro_zh",
        });
        await expectPgError(
          () =>
            target.query(`
              UPDATE "AuditEvent"
              SET
                "clientId" = 'client_other',
                "brandId" = 'brand_other',
                "siteId" = 'site_other_com',
                "siteMarketId" = 'site_market_other_my_en'
              WHERE "id" = 'audit_update_provenance'
            `),
          "23514",
          /polymorphic ownership mismatch.*AuditEvent.*ContentAsset/i,
        );
      });
    });

    it("rejects ownership updates of referenced polymorphic parents", async () => {
      await withFreshSchema("polymorphic_parent_update", async (target) => {
        await prepareEnforcedFreshSchema(target);
        await seedOtherOwnershipRoot(target);
        await cloneAuditEvent(target, {
          id: "audit_references_seo",
          entityType: "SeoAudit",
          entityId: "seo_audit_txpuro",
          siteMarketId: "site_market_txpuro_my_en",
        });
        await cloneEventDelivery(target, {
          id: "delivery_references_seo",
          entityType: "seo_audits",
          entityId: "seo_audit_txpuro",
          siteMarketId: "site_market_txpuro_my_en",
        });

        await expectPgError(
          () =>
            target.query(`
              UPDATE "SeoAudit"
              SET
                "clientId" = 'client_other',
                "brandId" = 'brand_other',
                "siteId" = 'site_other_com',
                "siteMarketId" = 'site_market_other_my_en'
              WHERE "id" = 'seo_audit_txpuro'
            `),
          "23514",
          /polymorphic ownership mismatch.*(AuditEvent|EventDelivery).*SeoAudit/i,
        );
      });
    });

    it("restricts deletion of referenced polymorphic parents", async () => {
      await withFreshSchema("polymorphic_parent_delete", async (target) => {
        await prepareEnforcedFreshSchema(target);
        await cloneAuditEvent(target, {
          id: "audit_restricts_seo_delete",
          entityType: "SEOAUDIT",
          entityId: "seo_audit_txpuro",
          siteMarketId: "site_market_txpuro_my_en",
        });

        await expectPgError(
          () =>
            target.query(`
              DELETE FROM "SeoAudit" WHERE "id" = 'seo_audit_txpuro'
            `),
          "23514",
          /polymorphic parent delete restricted.*SeoAudit.*seo_audit_txpuro/i,
        );
      });
    });

    it("restricts truncation of referenced polymorphic parents", async () => {
      await withFreshSchema("polymorphic_parent_truncate", async (target) => {
        await prepareEnforcedFreshSchema(target);
        await cloneAuditEvent(target, {
          id: "audit_restricts_seo_truncate",
          entityType: "seo_audits",
          entityId: "seo_audit_txpuro",
          siteMarketId: fixedOwnership.enMarketId,
        });

        for (const sql of [
          `TRUNCATE "SeoAudit"`,
          `TRUNCATE "SeoAudit" CASCADE`,
        ]) {
          await expectPgError(
            () => target.query(sql),
            "23514",
            /polymorphic parent truncate restricted.*SeoAudit/i,
          );
          const preserved = await target.query(`
            SELECT
              (SELECT count(*)::int FROM "SeoAudit"
                WHERE "id" = 'seo_audit_txpuro') AS parents,
              (SELECT count(*)::int FROM "AuditEvent"
                WHERE "id" = 'audit_restricts_seo_truncate') AS children
          `);
          expect(preserved.rows[0]).toEqual({ parents: 1, children: 1 });
        }
      });
    });

    it("allows truncation of a legacy parent with no polymorphic references", async () => {
      await withFreshSchema("polymorphic_parent_truncate_empty", async (target) => {
        await prepareEnforcedFreshSchema(target);

        await target.query(`TRUNCATE "SeoAudit"`);
        const remaining = await target.query(`
          SELECT count(*)::int AS count FROM "SeoAudit"
        `);
        expect(remaining.rows[0]?.count).toBe(0);
      });
    });

    it("installs immediate non-deferrable ownership constraint triggers", async () => {
      await withFreshSchema("immediate_trigger_catalog", async (target) => {
        await prepareEnforcedFreshSchema(target);
        const triggers = await target.query<{
          tgname: string;
          tgdeferrable: boolean;
          tginitdeferred: boolean;
        }>(`
          SELECT tgname, tgdeferrable, tginitdeferred
          FROM pg_trigger
          WHERE NOT tgisinternal
            AND tgconstraint <> 0
            AND tgrelid IN (
              SELECT format('%I.%I', current_schema(), table_name)::regclass
              FROM information_schema.tables
              WHERE table_schema = current_schema()
            )
        `);
        expect(triggers.rows.length).toBeGreaterThan(0);
        expect(
          triggers.rows.every(
            (trigger) => !trigger.tgdeferrable && !trigger.tginitdeferred,
          ),
        ).toBe(true);
      });
    });

    it("allows one-statement reparent and rejects a deferred two-step reparent", async () => {
      await withFreshSchema("immediate_reparent_behavior", async (target) => {
        await prepareEnforcedFreshSchema(target);
        await seedOtherOwnershipRoot(target);
        await target.query(`
          INSERT INTO "ContentAsset"
          SELECT (
            jsonb_populate_record(
              NULL::"ContentAsset",
              to_jsonb(seed) || jsonb_build_object(
                'id', 'asset_other',
                'clientId', 'client_other',
                'brandId', 'brand_other',
                'siteId', 'site_other_com',
                'siteMarketId', 'site_market_other_my_en',
                'title', 'Other asset',
                'slug', 'other-asset',
                'trendTopicId', NULL
              )
            )
          ).*
          FROM "ContentAsset" seed
          WHERE "id" = 'asset_txpuro_en'
        `);

        await target.query(`
          UPDATE "GeoRun"
          SET
            "contentAssetId" = 'asset_other',
            "clientId" = 'client_other',
            "brandId" = 'brand_other',
            "siteId" = 'site_other_com',
            "siteMarketId" = 'site_market_other_my_en'
          WHERE "id" = 'geo_run_txpuro_linked'
        `);
        const moved = await target.query(`
          SELECT "contentAssetId", "clientId", "siteId"
          FROM "GeoRun" WHERE "id" = 'geo_run_txpuro_linked'
        `);
        expect(moved.rows[0]).toEqual({
          contentAssetId: "asset_other",
          clientId: "client_other",
          siteId: "site_other_com",
        });

        await target.query(`
          UPDATE "GeoRun"
          SET
            "contentAssetId" = 'asset_txpuro_zh',
            "clientId" = 'client_wing_heng',
            "brandId" = 'brand_txpuro',
            "siteId" = 'site_txpuro_com',
            "siteMarketId" = 'site_market_txpuro_my_zh_cn'
          WHERE "id" = 'geo_run_txpuro_linked'
        `);
        await target.query("BEGIN");
        try {
          await target.query("SET CONSTRAINTS ALL DEFERRED");
          await expectPgError(
            () =>
              target.query(`
                UPDATE "GeoRun"
                SET "contentAssetId" = 'asset_other'
                WHERE "id" = 'geo_run_txpuro_linked'
              `),
            "23514",
            /referenced ownership mismatch.*GeoRun.*ContentAsset/i,
          );
        } finally {
          await target.query("ROLLBACK");
        }
      });
    });

    it("guards Client workspace reparenting but permits display updates", async () => {
      await withFreshSchema("client_workspace_guard", async (target) => {
        await prepareEnforcedFreshSchema(target);
        await target.query(`
          INSERT INTO "Workspace" (
            "id", "name", "slug", "createdAt", "updatedAt"
          ) VALUES (
            'workspace_guard_other', 'Other Workspace', 'guard-other',
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
        `);

        await expectPgError(
          () =>
            target.query(`
              UPDATE "Client"
              SET "workspaceId" = 'workspace_guard_other'
              WHERE "id" = 'client_wing_heng'
            `),
          "23514",
          /tenant parent reassignment.*Client.*client_wing_heng/i,
        );
        await target.query(`
          UPDATE "Client"
          SET "name" = 'Wing Heng Technology Display'
          WHERE "id" = 'client_wing_heng';
          UPDATE "Workspace"
          SET "name" = 'Internal GEO SEO Operations Display'
          WHERE "id" = 'workspace_internal';
        `);
      });
    });

    it("upgrades an applied base migration before removing ownership defaults", async () => {
      await withFreshSchema("contract_upgrade", async (target) => {
        await prepareBaseEnforcedFreshSchema(target);
        expect(await ownershipDefaultCount(target)).toBe(39);

        await applyMigration(target, contractMigrationPath);
        expect(await ownershipDefaultCount(target)).toBe(0);
        expect(await trendUniqueIndexNames(target)).toEqual([
          "TrendTopic_clientId_keyword_platform_key",
        ]);

        await expect(
          target.query(`
            INSERT INTO "TrendTopic" (
              "keyword", "platform", "score", "sourceType", "capturedAt"
            ) VALUES (
              'upgrade requires ownership', 'manual', 50, 'manual',
              CURRENT_TIMESTAMP
            )
          `),
        ).rejects.toMatchObject({ code: "23502" });
      });
    });

    it("scopes trend uniqueness by client on a fresh schema", async () => {
      await withFreshSchema("trend_client_unique", async (target) => {
        await prepareEnforcedFreshSchema(target);
        await seedOtherOwnershipRoot(target);

        await target.query(`
          INSERT INTO "TrendTopic" (
            "id", "clientId", "brandId", "siteId", "siteMarketId",
            "keyword", "platform", "score", "region", "sourceType",
            "status", "capturedAt"
          ) VALUES (
            'trend_unique_txpuro', 'client_wing_heng', 'brand_txpuro',
            'site_txpuro_com', 'site_market_txpuro_my_en',
            'shared trend contract', 'manual', 50, 'MY', 'manual',
            'pending', CURRENT_TIMESTAMP
          )
        `);
        await target.query(`
          INSERT INTO "TrendTopic" (
            "id", "clientId", "brandId", "siteId", "siteMarketId",
            "keyword", "platform", "score", "region", "sourceType",
            "status", "capturedAt"
          ) VALUES (
            'trend_unique_other', 'client_other', 'brand_other',
            'site_other_com', 'site_market_other_my_en',
            'shared trend contract', 'manual', 50, 'MY', 'manual',
            'pending', CURRENT_TIMESTAMP
          )
        `);

        await expectPgError(
          () =>
            target.query(`
              INSERT INTO "TrendTopic" (
                "id", "clientId", "brandId", "siteId", "siteMarketId",
                "keyword", "platform", "score", "region", "sourceType",
                "status", "capturedAt"
              ) VALUES (
                'trend_unique_txpuro_duplicate', 'client_wing_heng',
                'brand_txpuro', 'site_txpuro_com',
                'site_market_txpuro_my_en', 'shared trend contract',
                'manual', 51, 'MY', 'manual', 'pending', CURRENT_TIMESTAMP
              )
            `),
          "23505",
          /TrendTopic_clientId_keyword_platform_key/,
        );
      });
    });

    it("adds the generated-content business key on base to head upgrade", async () => {
      await withFreshSchema("generated_content_upgrade", async (target) => {
        await prepareBaseEnforcedFreshSchema(target);
        await applyMigration(target, contractMigrationPath);
        expect(await generatedContentUniqueIndexNames(target)).toEqual([]);

        await applyMigration(target, generatedContentMigrationPath);
        expect(await generatedContentUniqueIndexNames(target)).toEqual([
          "ContentAsset_clientId_sourceSystem_trendTopicId_templateId_key",
        ]);
      });
    });

    it("deploys fresh migrations and safely repeats deployment", async () => {
      await withFreshSchema("repeat_deploy", async (target, schema) => {
        await deployMigrations(schema);
        await deployMigrations(schema);

        const contractMigration = await target.query<{ count: number }>(`
          SELECT count(*)::int AS count
          FROM "_prisma_migrations"
          WHERE migration_name =
            '20260731120000_remove_legacy_ownership_defaults'
            AND finished_at IS NOT NULL
            AND rolled_back_at IS NULL
        `);
        expect(contractMigration.rows[0]?.count).toBe(1);
        const generatedContentMigration = await target.query<{ count: number }>(`
          SELECT count(*)::int AS count
          FROM "_prisma_migrations"
          WHERE migration_name =
            '20260731130000_generated_content_business_key'
            AND finished_at IS NOT NULL
            AND rolled_back_at IS NULL
        `);
        expect(generatedContentMigration.rows[0]?.count).toBe(1);
        expect(await trendUniqueIndexNames(target)).toEqual([
          "TrendTopic_clientId_keyword_platform_key",
        ]);
        expect(await generatedContentUniqueIndexNames(target)).toEqual([
          "ContentAsset_clientId_sourceSystem_trendTopicId_templateId_key",
        ]);
      });
    });

    it("replays all migrations from an empty PostgreSQL 16 schema", async () => {
      await withFreshSchema("replay", async (replayClient) => {
        for (const migrationPath of [
          ...legacyMigrationPaths,
          expandMigrationPath,
          backfillMigrationPath,
          enforceMigrationPath,
          contractMigrationPath,
          generatedContentMigrationPath,
        ]) {
          await applyMigration(replayClient, migrationPath);
        }
        const replayed = await replayClient.query(`
          SELECT
            (SELECT count(*)::int FROM "Workspace") AS workspaces,
            (SELECT count(*)::int FROM "SiteMarket") AS markets,
            (
              SELECT is_nullable
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'ContentAsset'
                AND column_name = 'clientId'
            ) AS "contentClientNullable",
            (
              SELECT count(*)::int
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = ANY($1::text[])
                AND column_name = ANY(ARRAY['clientId', 'brandId', 'siteId'])
                AND column_default IS NOT NULL
            ) AS "ownershipDefaults"
        `, [legacyTables]);
        expect(replayed.rows[0]).toEqual({
          workspaces: 1,
          markets: 2,
          contentClientNullable: "NO",
          ownershipDefaults: 0,
        });
        expect(await generatedContentUniqueIndexNames(replayClient)).toEqual([
          "ContentAsset_clientId_sourceSystem_trendTopicId_templateId_key",
        ]);
      });
    });
  },
);
