import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AccessScope } from "@/lib/authorization";
import {
  PrismaBusinessRepository,
  type OwnedContext,
} from "@/lib/business/repository";
import { ScopedPrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import type { ChannelVariant, ContentAsset, GEORun } from "@/types/geo";

const integrationEnabled = process.env.SGEO_DATABASE_INTEGRATION === "1";
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
const execFileAsync = promisify(execFile);

const ownership: OwnedContext = {
  clientId: "client_wing_heng",
  brandId: "brand_txpuro",
  siteId: "site_txpuro_com",
  siteMarketId: "site_market_txpuro_my_en",
};

const scope: AccessScope = {
  actorId: "reviewer_task9",
  workspaceId: "workspace_internal",
  clientIds: [ownership.clientId],
  role: "Reviewer",
};

let admin: Client;
let prisma: PrismaClient;
let schema = "";

function quoteIdentifier(identifier: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function generatedAsset(id: string): ContentAsset & { seoScore: number } {
  return {
    id,
    title: `Generated ${id}`,
    body: "Generated body",
    summary: "Generated summary",
    brandEntity: "Txpuro",
    sourceUrl: "https://txpuro.com/guides/trend/topic_task9",
    targetKeywords: ["approved task9 trend"],
    canonicalUrl: "https://txpuro.com/guides/trend/topic_task9",
    status: "Ready",
    geoScore: 84,
    seoScore: 78,
    updatedAt: new Date().toISOString(),
    owner: "geo-worker",
    sourceSystem: "trend_engine",
    locale: "en",
    assetType: "guide-page",
    schemaType: "article",
    ctaMode: "self_signup",
    publishTarget: "txpuro",
    isPublic: true,
    publishedPath: "/guides/trend/topic_task9",
  };
}

function generatedVariants(assetId: string, suffix: string): ChannelVariant[] {
  return ["LinkedIn", "WeChat"].map((platform, index) => ({
    id: `variant_${suffix}_${index}`,
    contentAssetId: assetId,
    platform: platform as ChannelVariant["platform"],
    accountId: `account_${suffix}`,
    copy: `Copy ${index}`,
    mediaAssets: [],
    scheduledAt: null,
    status: "Draft",
  }));
}

function geoRuns(): GEORun[] {
  return Array.from({ length: 80 }, (_, index) => ({
    id: `geo_task9_${index}`,
    projectId: ownership.siteId,
    prompt: `Prompt ${index}`,
    provider: "ChatGPT",
    locale: "en",
    competitors: [],
    modelAnswer: "Answer",
    brandMentioned: true,
    citedDomains: ["txpuro.com"],
    score: 80,
    recommendations: [],
    createdAt: new Date(1_700_000_000_000 + index).toISOString(),
    mode: "simulated",
  }));
}

async function deployMigrations(connectionString: string) {
  const deploymentUrl = new URL(connectionString);
  deploymentUrl.searchParams.set("schema", schema);
  await execFileAsync(resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: resolve("."),
    env: { ...process.env, DATABASE_URL: deploymentUrl.toString() },
  });
}

async function seedAsset(id: string) {
  await prisma.contentAsset.create({
    data: {
      ...ownership,
      id,
      title: `Asset ${id}`,
      body: "Body",
      summary: "Summary",
      brandEntity: "Txpuro",
      sourceUrl: `https://txpuro.com/${id}`,
      targetKeywords: ["task9"],
      canonicalUrl: `https://txpuro.com/${id}`,
      status: "Ready",
      owner: "task9",
      sourceSystem: "geo_ops",
      locale: "en",
      assetType: "guide-page",
      schemaType: "article",
      ctaMode: "self_signup",
      publishTarget: "txpuro",
      isPublic: true,
    },
  });
}

describe.skipIf(!integrationEnabled).sequential(
  "Task 9 business repositories on PostgreSQL 16",
  () => {
    beforeAll(async () => {
      if (!databaseUrl) {
        throw new Error("TEST_DATABASE_URL is required for database integration tests");
      }
      const parsed = new URL(databaseUrl);
      const databaseName = decodeURIComponent(parsed.pathname.slice(1));
      if (!/^sgeo_task4_test(?:_|$)/.test(databaseName)) {
        throw new Error(`Refusing database integration tests against ${databaseName}`);
      }
      parsed.searchParams.delete("schema");
      const connectionString = parsed.toString();
      admin = new Client({ connectionString, application_name: "sgeo-task9-repositories" });
      await admin.connect();
      const version = await admin.query<{ version: string }>(
        "SELECT current_setting('server_version_num') AS version",
      );
      expect(Number(version.rows[0]?.version)).toBeGreaterThanOrEqual(160_000);
      expect(Number(version.rows[0]?.version)).toBeLessThan(170_000);

      schema = `sgeo_task9_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await deployMigrations(connectionString);
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString }, { schema }),
      });
    });

    afterAll(async () => {
      await prisma?.$disconnect();
      if (!admin) return;
      if (schema.startsWith("sgeo_task9_")) {
        await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      }
      await admin.end();
    });

    beforeEach(async () => {
      await admin.query(`
        DROP TRIGGER IF EXISTS task9_fail_publish_outbox ON ${quoteIdentifier(schema)}."OutboxEvent";
        DROP FUNCTION IF EXISTS ${quoteIdentifier(schema)}.task9_fail_publish_outbox();
      `);
      await prisma.outboxEvent.deleteMany();
      await prisma.auditEvent.deleteMany();
      await prisma.geoFlowTaskLink.deleteMany();
      await prisma.channelVariant.deleteMany();
      await prisma.geoRun.deleteMany();
      await prisma.contentAsset.deleteMany();
      await prisma.trendTopic.deleteMany();
    });

    it("gates internal generation on approval and atomically reuses a concurrent business key", async () => {
      const business = new PrismaBusinessRepository(prisma);
      await prisma.trendTopic.create({
        data: {
          ...ownership,
          id: "topic_task9",
          keyword: "approved task9 trend",
          platform: "linkedin",
          score: 90,
          region: "MY",
          sourceType: "manual",
          status: "pending",
          capturedAt: new Date(),
        },
      });

      await expect(business.findInternalTrend("topic_task9")).resolves.toBeNull();
      await expect(
        business.generateContentForTrend({
          trendId: "topic_task9",
          ownership,
          templateId: "template_task9",
          asset: generatedAsset("asset_pending"),
          variants: generatedVariants("asset_pending", "pending"),
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      await prisma.trendTopic.update({
        where: { id: "topic_task9" },
        data: { status: "rejected" },
      });
      await expect(business.findInternalTrend("topic_task9")).resolves.toBeNull();
      expect(await prisma.contentAsset.count()).toBe(0);
      expect(await prisma.channelVariant.count()).toBe(0);
      expect(await prisma.auditEvent.count()).toBe(0);
      expect(await prisma.outboxEvent.count()).toBe(0);

      await prisma.trendTopic.update({
        where: { id: "topic_task9" },
        data: { status: "approved" },
      });
      await expect(business.findInternalTrend("topic_task9")).resolves.toMatchObject({
        id: "topic_task9",
        status: "approved",
      });

      const results = await Promise.all(
        ["a", "b"].map((suffix) => {
          const asset = generatedAsset(`asset_${suffix}`);
          return business.generateContentForTrend({
            trendId: "topic_task9",
            ownership,
            templateId: "template_task9",
            asset,
            variants: generatedVariants(asset.id, suffix),
          });
        }),
      );

      expect(results.map(({ reused }) => reused).sort()).toEqual([false, true]);
      expect(new Set(results.map(({ asset }) => asset.id)).size).toBe(1);
      expect(
        await prisma.contentAsset.count({
          where: {
            clientId: ownership.clientId,
            sourceSystem: "trend_engine",
            trendTopicId: "topic_task9",
            templateId: "template_task9",
          },
        }),
      ).toBe(1);
      expect(await prisma.channelVariant.count()).toBe(2);
      expect(await prisma.auditEvent.count({ where: { action: "content.generate" } })).toBe(1);
      expect(await prisma.outboxEvent.count({ where: { eventType: "content.generated" } })).toBe(1);
    });

    it("persists a concurrent 80-run GEO audit once with a Site outbox aggregate", async () => {
      const business = new PrismaBusinessRepository(prisma);
      const runs = geoRuns();

      await Promise.all([
        business.saveGeoRuns(scope, { siteId: ownership.siteId, runs }),
        business.saveGeoRuns(scope, { siteId: ownership.siteId, runs }),
      ]);
      await business.saveGeoRuns(scope, { siteId: ownership.siteId, runs });

      expect(await prisma.geoRun.count()).toBe(80);
      expect(await prisma.auditEvent.count({ where: { action: "geo.audit" } })).toBe(1);
      const events = await prisma.outboxEvent.findMany({
        where: { eventType: "geo.audit.completed" },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregateType: "Site",
        aggregateId: ownership.siteId,
      });
    });

    it("rolls back GEOFlow publication events and replays a successful publish once", async () => {
      await seedAsset("asset_publish");
      await prisma.geoFlowTaskLink.create({
        data: {
          ...ownership,
          id: "link_publish",
          contentAssetId: "asset_publish",
          geoFlowTaskId: 101,
          geoFlowJobId: 201,
          status: "reviewing",
          idempotencyKey: "task9-publish",
          taskPayload: { contentAssetId: "asset_publish" },
        },
      });
      const repository = new ScopedPrismaGeoFlowBridgeRepository(
        scope,
        undefined,
        ownership,
        prisma,
      );
      const publication = {
        geoFlowJobId: 201,
        geoFlowArticleId: 301,
        geoFlowArticleUrl: "https://txpuro.com/guides/task9-published",
        publishedAt: new Date("2026-07-31T10:00:00.000Z"),
      };

      await admin.query(`
        CREATE FUNCTION ${quoteIdentifier(schema)}.task9_fail_publish_outbox()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW."eventType" = 'geoflow.task.published' THEN
            RAISE EXCEPTION 'task9 injected outbox failure' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER task9_fail_publish_outbox
        BEFORE INSERT ON ${quoteIdentifier(schema)}."OutboxEvent"
        FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier(schema)}.task9_fail_publish_outbox();
      `);

      await expect(repository.commitPublishedLink("link_publish", publication)).rejects.toThrow(
        /task9 injected outbox failure/,
      );
      await expect(prisma.contentAsset.findUnique({ where: { id: "asset_publish" } }))
        .resolves.toMatchObject({ sourceSystem: "geo_ops", publishedAt: null });
      await expect(prisma.geoFlowTaskLink.findUnique({ where: { id: "link_publish" } }))
        .resolves.toMatchObject({ status: "reviewing", geoFlowArticleId: null });
      expect(await prisma.auditEvent.count({ where: { action: { contains: "publish" } } })).toBe(0);
      expect(await prisma.outboxEvent.count({ where: { eventType: { contains: "published" } } })).toBe(0);

      await admin.query(`
        DROP TRIGGER task9_fail_publish_outbox ON ${quoteIdentifier(schema)}."OutboxEvent";
        DROP FUNCTION ${quoteIdentifier(schema)}.task9_fail_publish_outbox();
      `);
      await repository.commitPublishedLink("link_publish", publication);
      await repository.commitPublishedLink("link_publish", publication);

      await expect(prisma.contentAsset.findUnique({ where: { id: "asset_publish" } }))
        .resolves.toMatchObject({
          sourceSystem: "geoflow",
          canonicalUrl: publication.geoFlowArticleUrl,
          externalUrl: publication.geoFlowArticleUrl,
          publishedAt: publication.publishedAt,
        });
      await expect(prisma.geoFlowTaskLink.findUnique({ where: { id: "link_publish" } }))
        .resolves.toMatchObject({
          status: "published",
          geoFlowArticleId: 301,
          geoFlowArticleUrl: publication.geoFlowArticleUrl,
        });
      expect(await prisma.auditEvent.count({ where: { action: "content_asset.publish" } })).toBe(1);
      expect(await prisma.auditEvent.count({ where: { action: "geoflow.task.publish" } })).toBe(1);
      expect(await prisma.outboxEvent.count({ where: { eventType: "content_asset.published" } })).toBe(1);
      expect(await prisma.outboxEvent.count({ where: { eventType: "geoflow.task.published" } })).toBe(1);
    });
  },
);
