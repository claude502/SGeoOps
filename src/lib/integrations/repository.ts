import { type Prisma, type PrismaClient } from "@prisma/client";

import type { AccessScope } from "@/lib/authorization";
import type { CreateIntegrationBody } from "@/lib/organization/schemas";
import {
  ScopedOrganizationError,
} from "@/lib/organization/repository";
import { scopedClientRelation } from "@/lib/organization/scope";
import { db } from "@/lib/prisma";

export interface IntegrationSummary {
  id: string;
  siteId: string;
  siteMarketId: string | null;
  type: string;
  endpoint: string | null;
  capabilities: string[];
  adapterVersion: string;
  secretConfigured: boolean;
  healthState: string;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateIntegrationInput = CreateIntegrationBody & {
  siteId: string;
};

export interface IntegrationRepository {
  listBySite(
    scope: AccessScope,
    siteId: string,
  ): Promise<IntegrationSummary[]>;
  create(
    scope: AccessScope,
    input: CreateIntegrationInput,
  ): Promise<IntegrationSummary>;
}

type IntegrationDatabase = Pick<
  PrismaClient,
  "site" | "siteMarket" | "integration"
>;

const integrationSelect = {
  id: true,
  siteId: true,
  siteMarketId: true,
  type: true,
  endpoint: true,
  capabilities: true,
  adapterVersion: true,
  secretRef: true,
  healthState: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.IntegrationSelect;

type IntegrationRecord = Prisma.IntegrationGetPayload<{
  select: typeof integrationSelect;
}>;

function toSummary(integration: IntegrationRecord): IntegrationSummary {
  const { secretRef, ...safeIntegration } = integration;
  return {
    ...safeIntegration,
    secretConfigured: secretRef !== null,
  };
}

function requireSite(record: { id: string } | null) {
  if (!record) {
    throw new ScopedOrganizationError("RESOURCE_NOT_FOUND");
  }
}

export class PrismaIntegrationRepository implements IntegrationRepository {
  constructor(private readonly database: IntegrationDatabase = db) {}

  private async requireScopedSite(scope: AccessScope, siteId: string) {
    const site = await this.database.site.findFirst({
      where: {
        id: siteId,
        brand: { client: scopedClientRelation(scope) },
      },
      select: { id: true },
    });
    requireSite(site);
  }

  async listBySite(
    scope: AccessScope,
    siteId: string,
  ): Promise<IntegrationSummary[]> {
    await this.requireScopedSite(scope, siteId);
    const integrations = await this.database.integration.findMany({
      where: {
        siteId,
        site: { brand: { client: scopedClientRelation(scope) } },
      },
      select: integrationSelect,
      orderBy: [{ type: "asc" }, { id: "asc" }],
    });
    return integrations.map(toSummary);
  }

  async create(
    scope: AccessScope,
    input: CreateIntegrationInput,
  ): Promise<IntegrationSummary> {
    await this.requireScopedSite(scope, input.siteId);

    if (input.siteMarketId) {
      requireSite(
        await this.database.siteMarket.findFirst({
          where: {
            id: input.siteMarketId,
            siteId: input.siteId,
            site: { brand: { client: scopedClientRelation(scope) } },
          },
          select: { id: true },
        }),
      );
    }

    return toSummary(
      await this.database.integration.create({
        data: {
          siteId: input.siteId,
          siteMarketId: input.siteMarketId,
          type: input.type,
          endpoint: input.endpoint,
          capabilities: input.capabilities,
          adapterVersion: input.adapterVersion,
          secretRef: input.secretRef,
        },
        select: integrationSelect,
      }),
    );
  }
}

export const integrationRepository = new PrismaIntegrationRepository();
