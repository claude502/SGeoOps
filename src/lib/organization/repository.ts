import { Prisma, type PrismaClient } from "@prisma/client";

import type { AccessScope } from "@/lib/authorization";
import type {
  CreateBrandBody,
  CreateClientBody,
  CreateSiteBody,
  CreateSiteMarketBody,
} from "@/lib/organization/schemas";
import { normalizeHost } from "@/lib/organization/schemas";
import {
  scopedClientIds,
  scopedClientRelation,
  scopedClientWhere,
} from "@/lib/organization/scope";
import { db } from "@/lib/prisma";

export type ScopedOrganizationErrorCode =
  | "RESOURCE_NOT_FOUND"
  | "INVALID_HOST"
  | "HOST_CONFLICT";

export class ScopedOrganizationError extends Error {
  constructor(readonly code: ScopedOrganizationErrorCode) {
    super(code);
    this.name = "ScopedOrganizationError";
  }
}

export interface ClientSummary {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientSiteOverview extends ClientSummary {
  sites: Array<{
    id: string;
    name: string;
    canonicalHost: string;
  }>;
}

export interface BrandSummary {
  id: string;
  clientId: string;
  name: string;
  slug: string;
  aliases: string[];
  products: Prisma.JsonValue | null;
  industry: string | null;
  goals: Prisma.JsonValue | null;
  riskCategory: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SiteSummary {
  id: string;
  brandId: string;
  name: string;
  canonicalHost: string;
  originHosts: string[];
  siteType: string;
  hostingMode: string;
  canonicalRules: Prisma.JsonValue;
  allowedPublishPaths: string[];
  ownershipVerifiedAt: Date | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SiteMarketSummary {
  id: string;
  siteId: string;
  country: string;
  locale: string;
  defaultDevice: string;
  timezone: string;
  settings: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SeoSiteContext {
  clientId: string;
  brandId: string;
  siteMarketId: string | null;
  site: SiteSummary;
  markets: SiteMarketSummary[];
}

export interface ResolvedPublicSite {
  workspaceId: string;
  clientId: string;
  brandId: string;
  siteId: string;
  name: string;
  canonicalHost: string;
  originHosts: string[];
  siteType: string;
  hostingMode: string;
  canonicalRules: Prisma.JsonValue;
  allowedPublishPaths: string[];
}

export type CreateClientInput = CreateClientBody;
export type CreateBrandInput = CreateBrandBody & { clientId: string };
export type CreateSiteInput = CreateSiteBody & { brandId: string };
export type CreateSiteMarketInput = CreateSiteMarketBody & { siteId: string };

export interface OrganizationRepository {
  listClients(scope: AccessScope): Promise<ClientSummary[]>;
  listClientSiteOverviews(scope: AccessScope): Promise<ClientSiteOverview[]>;
  createClient(
    scope: AccessScope,
    input: CreateClientInput,
  ): Promise<ClientSummary>;
  createBrand(
    scope: AccessScope,
    input: CreateBrandInput,
  ): Promise<BrandSummary>;
  createSite(scope: AccessScope, input: CreateSiteInput): Promise<SiteSummary>;
  createSiteMarket(
    scope: AccessScope,
    input: CreateSiteMarketInput,
  ): Promise<SiteMarketSummary>;
  getSite(scope: AccessScope, siteId: string): Promise<SiteSummary>;
  getSeoSiteContext(
    scope: AccessScope,
    siteId: string,
    siteMarketId: string | null,
  ): Promise<SeoSiteContext>;
  resolveSiteByHost(host: string): Promise<ResolvedPublicSite | null>;
}

type OrganizationDatabase = Pick<
  PrismaClient,
  "client" | "brand" | "site" | "siteMarket" | "$transaction"
>;

const clientSelect = {
  id: true,
  workspaceId: true,
  name: true,
  slug: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ClientSelect;

const clientSiteOverviewSelect = {
  ...clientSelect,
  brands: {
    select: {
      sites: {
        where: { active: true },
        select: {
          id: true,
          name: true,
          canonicalHost: true,
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      },
    },
  },
} satisfies Prisma.ClientSelect;

type ClientSiteOverviewRecord = Prisma.ClientGetPayload<{
  select: typeof clientSiteOverviewSelect;
}>;

function toClientSiteOverview(
  client: ClientSiteOverviewRecord,
): ClientSiteOverview {
  const { brands, ...summary } = client;
  return {
    ...summary,
    sites: brands.flatMap((brand) => brand.sites),
  };
}

const brandSelect = {
  id: true,
  clientId: true,
  name: true,
  slug: true,
  aliases: true,
  products: true,
  industry: true,
  goals: true,
  riskCategory: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BrandSelect;

const siteSelect = {
  id: true,
  brandId: true,
  name: true,
  canonicalHost: true,
  originHosts: true,
  siteType: true,
  hostingMode: true,
  canonicalRules: true,
  allowedPublishPaths: true,
  ownershipVerifiedAt: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SiteSelect;

const siteMarketSelect = {
  id: true,
  siteId: true,
  country: true,
  locale: true,
  defaultDevice: true,
  timezone: true,
  settings: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SiteMarketSelect;

const seoSiteSelect = {
  ...siteSelect,
  brand: { select: { clientId: true } },
  markets: {
    select: siteMarketSelect,
    orderBy: [{ country: "asc" }, { locale: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.SiteSelect;

type SeoSiteRecord = Prisma.SiteGetPayload<{
  select: typeof seoSiteSelect;
}>;

const publicSiteSelect = {
  id: true,
  brandId: true,
  name: true,
  canonicalHost: true,
  originHosts: true,
  siteType: true,
  hostingMode: true,
  canonicalRules: true,
  allowedPublishPaths: true,
  active: true,
  brand: {
    select: {
      clientId: true,
      client: {
        select: {
          workspaceId: true,
          active: true,
        },
      },
    },
  },
} satisfies Prisma.SiteSelect;

type PublicSiteRecord = Prisma.SiteGetPayload<{
  select: typeof publicSiteSelect;
}>;

function nullableJson(value: Prisma.InputJsonValue | null) {
  return value === null ? Prisma.DbNull : value;
}

function requireRecord<T>(record: T | null): T {
  if (!record) {
    throw new ScopedOrganizationError("RESOURCE_NOT_FOUND");
  }
  return record;
}

function toSeoSiteContext(
  record: SeoSiteRecord,
  siteMarketId: string | null,
): SeoSiteContext {
  const { brand, markets, ...site } = record;
  return {
    clientId: brand.clientId,
    brandId: site.brandId,
    siteMarketId,
    site,
    markets,
  };
}

function hasPrismaCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function toResolvedPublicSite(
  site: PublicSiteRecord,
): ResolvedPublicSite | null {
  if (!site.active || !site.brand.client.active) {
    return null;
  }
  return {
    workspaceId: site.brand.client.workspaceId,
    clientId: site.brand.clientId,
    brandId: site.brandId,
    siteId: site.id,
    name: site.name,
    canonicalHost: site.canonicalHost,
    originHosts: site.originHosts,
    siteType: site.siteType,
    hostingMode: site.hostingMode,
    canonicalRules: site.canonicalRules,
    allowedPublishPaths: site.allowedPublishPaths,
  };
}

export class PrismaOrganizationRepository implements OrganizationRepository {
  constructor(private readonly database: OrganizationDatabase = db) {}

  async listClients(scope: AccessScope): Promise<ClientSummary[]> {
    return this.database.client.findMany({
      where: scopedClientWhere(scope),
      select: clientSelect,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
  }

  async listClientSiteOverviews(
    scope: AccessScope,
  ): Promise<ClientSiteOverview[]> {
    const clients = await this.database.client.findMany({
      where: scopedClientWhere(scope),
      select: clientSiteOverviewSelect,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return clients.map(toClientSiteOverview);
  }

  async createClient(
    scope: AccessScope,
    input: CreateClientInput,
  ): Promise<ClientSummary> {
    return this.database.client.create({
      data: {
        workspaceId: scope.workspaceId,
        name: input.name,
        slug: input.slug,
        active: input.active,
      },
      select: clientSelect,
    });
  }

  async createBrand(
    scope: AccessScope,
    input: CreateBrandInput,
  ): Promise<BrandSummary> {
    requireRecord(
      await this.database.client.findFirst({
        where: {
          id: input.clientId,
          workspaceId: scope.workspaceId,
          AND: [{ id: { in: scopedClientIds(scope) } }],
        },
        select: { id: true },
      }),
    );

    return this.database.brand.create({
      data: {
        clientId: input.clientId,
        name: input.name,
        slug: input.slug,
        aliases: input.aliases,
        products: nullableJson(input.products),
        industry: input.industry,
        goals: nullableJson(input.goals),
        riskCategory: input.riskCategory,
      },
      select: brandSelect,
    });
  }

  async createSite(
    scope: AccessScope,
    input: CreateSiteInput,
  ): Promise<SiteSummary> {
    try {
      return await this.database.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(1936484701::bigint)::text AS locked
        `;

        requireRecord(
          await transaction.brand.findFirst({
            where: {
              id: input.brandId,
              client: scopedClientRelation(scope),
            },
            select: { id: true },
          }),
        );

        const claims = [
          ...new Set([input.canonicalHost, ...input.originHosts]),
        ];
        const conflictingSite = await transaction.site.findFirst({
          where: {
            OR: [
              { canonicalHost: { in: claims } },
              { originHosts: { hasSome: claims } },
            ],
          },
          select: { id: true },
        });
        if (conflictingSite) {
          throw new ScopedOrganizationError("HOST_CONFLICT");
        }

        return transaction.site.create({
          data: {
            brandId: input.brandId,
            name: input.name,
            canonicalHost: input.canonicalHost,
            originHosts: input.originHosts,
            siteType: input.siteType,
            hostingMode: input.hostingMode,
            canonicalRules: input.canonicalRules,
            allowedPublishPaths: input.allowedPublishPaths,
            active: input.active,
          },
          select: siteSelect,
        });
      });
    } catch (error) {
      if (hasPrismaCode(error, "P2002")) {
        throw new ScopedOrganizationError("HOST_CONFLICT");
      }
      throw error;
    }
  }

  async createSiteMarket(
    scope: AccessScope,
    input: CreateSiteMarketInput,
  ): Promise<SiteMarketSummary> {
    requireRecord(
      await this.database.site.findFirst({
        where: {
          id: input.siteId,
          brand: { client: scopedClientRelation(scope) },
        },
        select: { id: true },
      }),
    );

    return this.database.siteMarket.create({
      data: {
        siteId: input.siteId,
        country: input.country,
        locale: input.locale,
        defaultDevice: input.defaultDevice,
        timezone: input.timezone,
        settings: nullableJson(input.settings),
      },
      select: siteMarketSelect,
    });
  }

  async getSite(scope: AccessScope, siteId: string): Promise<SiteSummary> {
    return requireRecord(
      await this.database.site.findFirst({
        where: {
          id: siteId,
          brand: { client: scopedClientRelation(scope) },
        },
        select: siteSelect,
      }),
    );
  }

  async getSeoSiteContext(
    scope: AccessScope,
    siteId: string,
    siteMarketId: string | null,
  ): Promise<SeoSiteContext> {
    const record = requireRecord(
      await this.database.site.findFirst({
        where: {
          id: siteId,
          brand: { client: scopedClientRelation(scope) },
          ...(siteMarketId === null
            ? {}
            : { markets: { some: { id: siteMarketId } } }),
        },
        select: seoSiteSelect,
      }),
    );
    return toSeoSiteContext(record, siteMarketId);
  }

  async resolveSiteByHost(host: string): Promise<ResolvedPublicSite | null> {
    let normalizedHost: string;
    try {
      normalizedHost = normalizeHost(host);
    } catch {
      throw new ScopedOrganizationError("INVALID_HOST");
    }

    const canonicalSite = await this.database.site.findUnique({
      where: { canonicalHost: normalizedHost },
      select: publicSiteSelect,
    });
    if (canonicalSite) {
      return toResolvedPublicSite(canonicalSite);
    }

    const aliases = await this.database.site.findMany({
      where: {
        active: true,
        brand: { client: { active: true } },
        originHosts: { has: normalizedHost },
      },
      select: publicSiteSelect,
      orderBy: { id: "asc" },
      take: 2,
    });
    if (aliases.length !== 1) {
      return null;
    }
    return toResolvedPublicSite(aliases[0]);
  }
}

export const organizationRepository = new PrismaOrganizationRepository();
