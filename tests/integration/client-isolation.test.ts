import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { AccessScope } from "../../src/lib/authorization";
import { PrismaBusinessRepository } from "../../src/lib/business/repository";
import { PrismaIntegrationRepository } from "../../src/lib/integrations/repository";
import {
  PrismaOrganizationRepository,
  ScopedOrganizationError,
} from "../../src/lib/organization/repository";
import type { ContentAsset } from "../../src/types/geo";

const integrationEnabled = process.env.SGEO_DATABASE_INTEGRATION === "1";
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";

const scopeA: AccessScope = {
  actorId: "operator_a",
  workspaceId: "workspace_internal",
  role: "Operator",
  clientIds: ["client_a"],
};

const scopeB: AccessScope = {
  actorId: "operator_b",
  workspaceId: "workspace_internal",
  role: "Operator",
  clientIds: ["client_b"],
};

let adminClient: Client;
let prisma: PrismaClient;
let schema = "";
let organizations: PrismaOrganizationRepository;
let integrations: PrismaIntegrationRepository;
let business: PrismaBusinessRepository;

function quoteIdentifier(identifier: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function seedOwnership() {
  await adminClient.query(`
    INSERT INTO "Workspace" ("id", "name", "slug", "updatedAt")
    VALUES (
      'workspace_internal',
      'Internal Operations',
      'internal',
      CURRENT_TIMESTAMP
    );

    INSERT INTO "Client" (
      "id", "workspaceId", "name", "slug", "active", "updatedAt"
    ) VALUES
      (
        'client_a', 'workspace_internal', 'Client A', 'client-a',
        true, CURRENT_TIMESTAMP
      ),
      (
        'client_b', 'workspace_internal', 'Client B', 'client-b',
        true, CURRENT_TIMESTAMP
      ),
      (
        'client_inactive', 'workspace_internal', 'Inactive Client',
        'inactive-client', false, CURRENT_TIMESTAMP
      );

    INSERT INTO "Brand" (
      "id", "clientId", "name", "slug", "aliases", "updatedAt"
    ) VALUES
      (
        'brand_a', 'client_a', 'Brand A', 'brand-a',
        ARRAY[]::TEXT[], CURRENT_TIMESTAMP
      ),
      (
        'brand_b', 'client_b', 'Brand B', 'brand-b',
        ARRAY[]::TEXT[], CURRENT_TIMESTAMP
      ),
      (
        'brand_inactive', 'client_inactive', 'Inactive Brand',
        'inactive-brand', ARRAY[]::TEXT[], CURRENT_TIMESTAMP
      );

    INSERT INTO "Site" (
      "id", "brandId", "name", "canonicalHost", "originHosts",
      "siteType", "hostingMode", "canonicalRules",
      "allowedPublishPaths", "active", "updatedAt"
    ) VALUES
      (
        'site_a', 'brand_a', 'Site A', 'site-a.example.com',
        ARRAY['origin-a.example.com'], 'content', 'hosted',
        '{"https":true}'::JSONB, ARRAY['/guides'], true,
        CURRENT_TIMESTAMP
      ),
      (
        'site_b', 'brand_b', 'Site B', 'site-b.example.com',
        ARRAY['origin-b.example.com'], 'content', 'external',
        '{"https":true}'::JSONB, ARRAY['/answers'], true,
        CURRENT_TIMESTAMP
      ),
      (
        'site_inactive', 'brand_a', 'Inactive Site',
        'inactive-site.example.com', ARRAY[]::TEXT[], 'content', 'hosted',
        '{}'::JSONB, ARRAY[]::TEXT[], false, CURRENT_TIMESTAMP
      ),
      (
        'site_inactive_client', 'brand_inactive', 'Inactive Client Site',
        'inactive-client.example.com', ARRAY[]::TEXT[], 'content', 'hosted',
        '{}'::JSONB, ARRAY[]::TEXT[], true, CURRENT_TIMESTAMP
      );

    INSERT INTO "SiteMarket" (
      "id", "siteId", "country", "locale", "defaultDevice",
      "timezone", "updatedAt"
    ) VALUES
      (
        'market_a', 'site_a', 'MY', 'en-MY', 'desktop',
        'Asia/Kuala_Lumpur', CURRENT_TIMESTAMP
      ),
      (
        'market_b', 'site_b', 'SG', 'en-SG', 'desktop',
        'Asia/Singapore', CURRENT_TIMESTAMP
      );

    INSERT INTO "Integration" (
      "id", "siteId", "siteMarketId", "type", "endpoint",
      "capabilities", "adapterVersion", "secretRef", "updatedAt"
    ) VALUES
      (
        'integration_a', 'site_a', 'market_a', 'wordpress',
        'https://cms-a.example.com', ARRAY['publish'], '1.0.0',
        'file:client-a/wordpress-token', CURRENT_TIMESTAMP
      ),
      (
        'integration_b', 'site_b', 'market_b', 'webflow',
        'https://cms-b.example.com', ARRAY['publish'], '1.0.0',
        'file:client-b/webflow-token', CURRENT_TIMESTAMP
      );

    INSERT INTO "ContentAsset" (
      "id", "clientId", "brandId", "siteId", "title", "body", "summary",
      "brandEntity", "sourceUrl", "targetKeywords", "canonicalUrl", "status",
      "geoScore", "owner", "sourceSystem", "locale", "assetType",
      "schemaType", "ctaMode", "publishTarget", "isPublic", "updatedAt"
    ) VALUES
      (
        'asset_a', 'client_a', 'brand_a', 'site_a', 'Asset A', 'Body A',
        'Summary A', 'Brand A', 'https://site-a.example.com/a',
        ARRAY['a'], 'https://site-a.example.com/a', 'Ready', 80,
        'operator_a', 'geo_ops', 'en', 'guide-page', 'article',
        'self_signup', 'geo_ops_internal', true, CURRENT_TIMESTAMP
      ),
      (
        'asset_b', 'client_b', 'brand_b', 'site_b', 'Asset B', 'Body B',
        'Summary B', 'Brand B', 'https://site-b.example.com/b',
        ARRAY['b'], 'https://site-b.example.com/b', 'Ready', 80,
        'operator_b', 'geo_ops', 'en', 'guide-page', 'article',
        'self_signup', 'geo_ops_internal', true, CURRENT_TIMESTAMP
      );
  `);
}

function newAsset(id: string): ContentAsset {
  return {
    id,
    title: "Atomic asset",
    body: "Atomic body",
    summary: "Atomic summary",
    brandEntity: "Brand A",
    sourceUrl: "https://site-a.example.com/atomic",
    targetKeywords: ["atomic"],
    canonicalUrl: "https://site-a.example.com/atomic",
    status: "Draft",
    geoScore: 0,
    updatedAt: new Date().toISOString(),
    owner: "operator_a",
    sourceSystem: "geo_ops",
    externalUrl: null,
    publishedAt: null,
    slug: "atomic",
    locale: "en",
    assetType: "guide-page",
    audience: null,
    seoTitle: "Atomic asset",
    metaDescription: "Atomic summary",
    faqs: [],
    schemaType: "article",
    ctaMode: "self_signup",
    publishTarget: "geo_ops_internal",
    isPublic: false,
    publishedPath: "/atomic",
  };
}

describe.skipIf(!integrationEnabled).sequential(
  "client isolation on PostgreSQL 16",
  () => {
    beforeAll(async () => {
      if (!databaseUrl) {
        throw new Error(
          "TEST_DATABASE_URL is required for database integration tests",
        );
      }

      const parsedUrl = new URL(databaseUrl);
      const databaseName = decodeURIComponent(parsedUrl.pathname.slice(1));
      if (!/^sgeo_task(?:4|7)_test(?:_|$)/.test(databaseName)) {
        throw new Error(
          `Refusing database integration tests against unguarded database ${databaseName}`,
        );
      }
      parsedUrl.searchParams.delete("schema");
      const connectionString = parsedUrl.toString();

      adminClient = new Client({
        connectionString,
        application_name: "sgeo-task7-client-isolation",
      });
      await adminClient.connect();

      const database = await adminClient.query<{
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

      schema = `sgeo_task7_isolation_${process.pid}_${randomUUID()
        .replaceAll("-", "")
        .slice(0, 10)}`;
      await adminClient.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await adminClient.query(
        `SET search_path TO ${quoteIdentifier(schema)}`,
      );
      await adminClient.query(`
        CREATE TABLE "Workspace" (
          "id" TEXT PRIMARY KEY,
          "name" TEXT NOT NULL,
          "slug" TEXT NOT NULL UNIQUE,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL
        );

        CREATE TABLE "Client" (
          "id" TEXT PRIMARY KEY,
          "workspaceId" TEXT NOT NULL
            REFERENCES "Workspace"("id") ON DELETE RESTRICT,
          "name" TEXT NOT NULL,
          "slug" TEXT NOT NULL,
          "active" BOOLEAN NOT NULL DEFAULT true,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          UNIQUE ("workspaceId", "slug")
        );

        CREATE TABLE "Brand" (
          "id" TEXT PRIMARY KEY,
          "clientId" TEXT NOT NULL
            REFERENCES "Client"("id") ON DELETE RESTRICT,
          "name" TEXT NOT NULL,
          "slug" TEXT NOT NULL,
          "aliases" TEXT[] NOT NULL,
          "products" JSONB,
          "industry" TEXT,
          "goals" JSONB,
          "riskCategory" TEXT NOT NULL DEFAULT 'standard',
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          UNIQUE ("clientId", "slug")
        );

        CREATE TABLE "Site" (
          "id" TEXT PRIMARY KEY,
          "brandId" TEXT NOT NULL
            REFERENCES "Brand"("id") ON DELETE RESTRICT,
          "name" TEXT NOT NULL,
          "canonicalHost" TEXT NOT NULL UNIQUE,
          "originHosts" TEXT[] NOT NULL,
          "siteType" TEXT NOT NULL,
          "hostingMode" TEXT NOT NULL,
          "canonicalRules" JSONB NOT NULL,
          "allowedPublishPaths" TEXT[] NOT NULL,
          "ownershipVerifiedAt" TIMESTAMP(3),
          "active" BOOLEAN NOT NULL DEFAULT true,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL
        );

        CREATE TABLE "SiteMarket" (
          "id" TEXT PRIMARY KEY,
          "siteId" TEXT NOT NULL
            REFERENCES "Site"("id") ON DELETE CASCADE,
          "country" TEXT NOT NULL,
          "locale" TEXT NOT NULL,
          "defaultDevice" TEXT NOT NULL DEFAULT 'desktop',
          "timezone" TEXT NOT NULL,
          "settings" JSONB,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          UNIQUE ("siteId", "country", "locale")
        );

        CREATE TABLE "Integration" (
          "id" TEXT PRIMARY KEY,
          "siteId" TEXT NOT NULL
            REFERENCES "Site"("id") ON DELETE CASCADE,
          "siteMarketId" TEXT
            REFERENCES "SiteMarket"("id") ON DELETE CASCADE,
          "type" TEXT NOT NULL,
          "endpoint" TEXT,
          "capabilities" TEXT[] NOT NULL,
          "adapterVersion" TEXT NOT NULL,
          "secretRef" TEXT,
          "healthState" TEXT NOT NULL DEFAULT 'unknown',
          "lastCheckedAt" TIMESTAMP(3),
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          UNIQUE ("siteId", "siteMarketId", "type")
        );

        CREATE TYPE "ContentStatus" AS ENUM (
          'Draft', 'Review', 'Ready', 'Published', 'Paused'
        );

        CREATE TABLE "ContentAsset" (
          "id" TEXT PRIMARY KEY,
          "clientId" TEXT NOT NULL REFERENCES "Client"("id"),
          "brandId" TEXT NOT NULL REFERENCES "Brand"("id"),
          "siteId" TEXT NOT NULL REFERENCES "Site"("id"),
          "siteMarketId" TEXT REFERENCES "SiteMarket"("id"),
          "title" TEXT NOT NULL,
          "body" TEXT NOT NULL,
          "summary" TEXT NOT NULL,
          "brandEntity" TEXT NOT NULL,
          "sourceUrl" TEXT NOT NULL,
          "targetKeywords" TEXT[] NOT NULL,
          "canonicalUrl" TEXT NOT NULL,
          "status" "ContentStatus" NOT NULL DEFAULT 'Draft',
          "geoScore" INTEGER NOT NULL DEFAULT 0,
          "owner" TEXT NOT NULL,
          "sourceSystem" TEXT NOT NULL DEFAULT 'geo_ops',
          "externalUrl" TEXT,
          "publishedAt" TIMESTAMP(3),
          "slug" TEXT,
          "locale" TEXT NOT NULL DEFAULT 'zh-CN',
          "assetType" TEXT NOT NULL DEFAULT 'guide-page',
          "audience" TEXT,
          "seoTitle" TEXT,
          "metaDescription" TEXT,
          "faqs" JSONB,
          "schemaType" TEXT NOT NULL DEFAULT 'article',
          "ctaMode" TEXT NOT NULL DEFAULT 'self_signup',
          "publishTarget" TEXT NOT NULL DEFAULT 'geo_ops_internal',
          "isPublic" BOOLEAN NOT NULL DEFAULT false,
          "publishedPath" TEXT,
          "seoScore" INTEGER,
          "trendTopicId" TEXT,
          "templateId" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL
        );

        CREATE TABLE "AuditEvent" (
          "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          "clientId" TEXT NOT NULL REFERENCES "Client"("id"),
          "brandId" TEXT NOT NULL REFERENCES "Brand"("id"),
          "siteId" TEXT NOT NULL REFERENCES "Site"("id"),
          "siteMarketId" TEXT REFERENCES "SiteMarket"("id"),
          "actor" TEXT NOT NULL,
          "action" TEXT NOT NULL,
          "entityType" TEXT NOT NULL,
          "entityId" TEXT,
          "outcome" TEXT NOT NULL,
          "requestId" TEXT,
          "metadata" JSONB,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE "OutboxEvent" (
          "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          "aggregateType" TEXT NOT NULL,
          "aggregateId" TEXT NOT NULL,
          "eventType" TEXT NOT NULL,
          "payload" JSONB NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'pending',
          "attemptCount" INTEGER NOT NULL DEFAULT 0,
          "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "sentAt" TIMESTAMP(3),
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString }, { schema }),
      });
      organizations = new PrismaOrganizationRepository(prisma);
      integrations = new PrismaIntegrationRepository(prisma);
      business = new PrismaBusinessRepository(prisma);
    });

    afterAll(async () => {
      await prisma?.$disconnect();
      if (!adminClient) return;
      await adminClient.query("SET search_path TO public");
      if (schema.startsWith("sgeo_task7_isolation_")) {
        await adminClient.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
        );
      }
      await adminClient.end();
    });

    beforeEach(async () => {
      await adminClient.query(`
        TRUNCATE TABLE
          "Integration", "SiteMarket", "Site", "Brand", "Client", "Workspace"
        CASCADE
      `);
      await seedOwnership();
    });

    it("lists and gets only Client A data with identical denial semantics", async () => {
      await expect(organizations.listClients(scopeA)).resolves.toEqual([
        expect.objectContaining({ id: "client_a" }),
      ]);
      await expect(organizations.getSite(scopeA, "site_a")).resolves.toMatchObject(
        { id: "site_a", brandId: "brand_a" },
      );

      for (const siteId of ["site_b", "site_missing"]) {
        await expect(
          organizations.getSite(scopeA, siteId),
        ).rejects.toMatchObject({
          name: "ScopedOrganizationError",
          code: "RESOURCE_NOT_FOUND",
        });
      }
    });

    it("returns identical null results for a Client B asset and a missing asset", async () => {
      await expect(
        business.findContentAsset(scopeA, "asset_a"),
      ).resolves.toMatchObject({
        id: "asset_a",
        clientId: "client_a",
        siteId: "site_a",
      });
      await expect(
        business.findContentAsset(scopeA, "asset_b"),
      ).resolves.toBeNull();
      await expect(
        business.findContentAsset(scopeA, "asset_missing"),
      ).resolves.toBeNull();
    });

    it("rolls back the business write and audit when outbox creation fails", async () => {
      await adminClient.query(`
        CREATE FUNCTION fail_task9_outbox()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'forced outbox failure';
        END
        $$;
        CREATE TRIGGER fail_task9_outbox
        BEFORE INSERT ON "OutboxEvent"
        FOR EACH ROW EXECUTE FUNCTION fail_task9_outbox();
      `);

      await expect(
        business.createContentAsset(
          scopeA,
          "site_a",
          newAsset("asset_atomic_rollback"),
        ),
      ).rejects.toThrow("forced outbox failure");

      const [assetCount, auditCount] = await Promise.all([
        prisma.contentAsset.count({
          where: { id: "asset_atomic_rollback" },
        }),
        prisma.auditEvent.count({
          where: { entityId: "asset_atomic_rollback" },
        }),
      ]);
      expect(assetCount).toBe(0);
      expect(auditCount).toBe(0);

      await adminClient.query(`
        DROP TRIGGER fail_task9_outbox ON "OutboxEvent";
        DROP FUNCTION fail_task9_outbox();
      `);
    });

    it("cannot create brands, sites, or markets below Client B", async () => {
      await expect(
        organizations.createBrand(scopeA, {
          clientId: "client_b",
          name: "Injected Brand",
          slug: "injected-brand",
          aliases: [],
          products: null,
          industry: null,
          goals: null,
          riskCategory: "standard",
        }),
      ).rejects.toBeInstanceOf(ScopedOrganizationError);

      await expect(
        organizations.createSite(scopeA, {
          brandId: "brand_b",
          name: "Injected Site",
          canonicalHost: "injected.example.com",
          originHosts: [],
          siteType: "content",
          hostingMode: "hosted",
          canonicalRules: {},
          allowedPublishPaths: [],
          active: true,
        }),
      ).rejects.toBeInstanceOf(ScopedOrganizationError);

      await expect(
        organizations.createSiteMarket(scopeA, {
          siteId: "site_b",
          country: "MY",
          locale: "ms-MY",
          defaultDevice: "desktop",
          timezone: "Asia/Kuala_Lumpur",
          settings: null,
        }),
      ).rejects.toBeInstanceOf(ScopedOrganizationError);

      const injected = await adminClient.query<{ count: number }>(`
        SELECT count(*)::int AS count
        FROM "Brand"
        WHERE "slug" = 'injected-brand'
      `);
      expect(injected.rows[0]?.count).toBe(0);
    });

    it("creates a complete organization and integration chain below Client A", async () => {
      const brand = await organizations.createBrand(scopeA, {
        clientId: "client_a",
        name: "Brand A Two",
        slug: "brand-a-two",
        aliases: ["Brand A2"],
        products: { names: ["Product A"] },
        industry: "software",
        goals: { primary: "visibility" },
        riskCategory: "standard",
      });
      const site = await organizations.createSite(scopeA, {
        brandId: brand.id,
        name: "Site A Two",
        canonicalHost: "site-a-two.example.com",
        originHosts: ["origin-a-two.example.com"],
        siteType: "content",
        hostingMode: "hosted",
        canonicalRules: { https: true },
        allowedPublishPaths: ["/guides"],
        active: true,
      });
      const market = await organizations.createSiteMarket(scopeA, {
        siteId: site.id,
        country: "MY",
        locale: "en-MY",
        defaultDevice: "desktop",
        timezone: "Asia/Kuala_Lumpur",
        settings: { currency: "MYR" },
      });
      const integration = await integrations.create(scopeA, {
        siteId: site.id,
        siteMarketId: market.id,
        type: "api",
        endpoint: "https://publisher-a.example.com",
        capabilities: ["publish"],
        adapterVersion: "1.0.0",
        secretRef: "file:client-a/publisher-token",
      });

      expect(brand.clientId).toBe("client_a");
      expect(site.brandId).toBe(brand.id);
      expect(market.siteId).toBe(site.id);
      expect(integration).toMatchObject({
        siteId: site.id,
        siteMarketId: market.id,
        secretConfigured: true,
      });
      expect(integration).not.toHaveProperty("secretRef");
    });

    it("cannot list or create Client B integrations", async () => {
      await expect(
        integrations.listBySite(scopeA, "site_b"),
      ).rejects.toBeInstanceOf(ScopedOrganizationError);
      await expect(
        integrations.create(scopeA, {
          siteId: "site_b",
          siteMarketId: "market_b",
          type: "api",
          endpoint: "https://api.example.com",
          capabilities: ["publish"],
          adapterVersion: "1.0.0",
          secretRef: "file:client-b/api-token",
        }),
      ).rejects.toBeInstanceOf(ScopedOrganizationError);
      await expect(
        integrations.create(scopeA, {
          siteId: "site_a",
          siteMarketId: "market_b",
          type: "api",
          endpoint: "https://api.example.com",
          capabilities: ["publish"],
          adapterVersion: "1.0.0",
          secretRef: "file:client-a/api-token",
        }),
      ).rejects.toBeInstanceOf(ScopedOrganizationError);

      const [integration] = await integrations.listBySite(scopeA, "site_a");
      expect(integration).toMatchObject({
        id: "integration_a",
        siteId: "site_a",
        secretConfigured: true,
      });
      expect(integration).not.toHaveProperty("secretRef");
    });

    it("prioritizes canonical claims and fails closed for ambiguous aliases", async () => {
      await adminClient.query(`
        UPDATE "Site"
        SET "originHosts" = array_append(
          "originHosts",
          'site-b.example.com'
        )
        WHERE "id" = 'site_a';
      `);
      await expect(
        organizations.resolveSiteByHost("site-b.example.com"),
      ).resolves.toMatchObject({
        clientId: "client_b",
        siteId: "site_b",
      });

      await adminClient.query(`
        UPDATE "Site"
        SET "originHosts" = array_append(
          "originHosts",
          'shared.example.com'
        )
        WHERE "id" IN ('site_a', 'site_b');
      `);
      await expect(
        organizations.resolveSiteByHost("shared.example.com"),
      ).resolves.toBeNull();
    });

    it("rejects existing and concurrent host claim collisions", async () => {
      await expect(
        organizations.createSite(scopeA, {
          brandId: "brand_a",
          name: "Existing Alias Collision",
          canonicalHost: "origin-a.example.com",
          originHosts: [],
          siteType: "content",
          hostingMode: "hosted",
          canonicalRules: {},
          allowedPublishPaths: [],
          active: true,
        }),
      ).rejects.toMatchObject({ code: "HOST_CONFLICT" });

      const results = await Promise.allSettled([
        organizations.createSite(scopeA, {
          brandId: "brand_a",
          name: "Race Site A",
          canonicalHost: "race-a.example.com",
          originHosts: ["race-shared.example.com"],
          siteType: "content",
          hostingMode: "hosted",
          canonicalRules: {},
          allowedPublishPaths: [],
          active: true,
        }),
        organizations.createSite(scopeB, {
          brandId: "brand_b",
          name: "Race Site B",
          canonicalHost: "race-b.example.com",
          originHosts: ["race-shared.example.com"],
          siteType: "content",
          hostingMode: "external",
          canonicalRules: {},
          allowedPublishPaths: [],
          active: true,
        }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
        1,
      );
      const [rejected] = results.filter(
        (result) => result.status === "rejected",
      );
      expect(rejected).toMatchObject({
        reason: {
          name: "ScopedOrganizationError",
          code: "HOST_CONFLICT",
        },
      });
      const claims = await adminClient.query<{ count: number }>(`
        SELECT count(*)::int AS count
        FROM "Site"
        WHERE "originHosts" @> ARRAY['race-shared.example.com']::TEXT[]
      `);
      expect(claims.rows[0]?.count).toBe(1);
    });

    it("resolves normalized public hosts only through active ownership", async () => {
      await expect(
        organizations.resolveSiteByHost("SITE-A.EXAMPLE.COM.:443"),
      ).resolves.toMatchObject({
        workspaceId: "workspace_internal",
        clientId: "client_a",
        brandId: "brand_a",
        siteId: "site_a",
      });
      await expect(
        organizations.resolveSiteByHost("ORIGIN-A.EXAMPLE.COM:80"),
      ).resolves.toMatchObject({ siteId: "site_a" });
      await expect(
        organizations.resolveSiteByHost("inactive-site.example.com"),
      ).resolves.toBeNull();
      await expect(
        organizations.resolveSiteByHost("inactive-client.example.com"),
      ).resolves.toBeNull();
      await expect(
        organizations.resolveSiteByHost("https://site-a.example.com/path"),
      ).rejects.toMatchObject({ code: "INVALID_HOST" });
    });
  },
);
