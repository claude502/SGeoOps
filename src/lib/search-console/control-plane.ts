import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  FileSecretResolver,
  type SecretRef,
  type SecretResolver,
} from "@/lib/integrations/secret-resolver";
import { db } from "@/lib/prisma";

export type SearchConsoleControlScope = {
  runId: string;
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
  integrationId: string;
  property: string;
};

export type SearchConsoleControlErrorCode =
  | "RESOURCE_NOT_FOUND"
  | "CREDENTIAL_UNAVAILABLE";

export class SearchConsoleControlError extends Error {
  constructor(readonly code: SearchConsoleControlErrorCode) {
    super(code);
    this.name = "SearchConsoleControlError";
  }
}

export interface SearchConsoleControlRepository {
  getCredentialReference(scope: SearchConsoleControlScope): Promise<SecretRef>;
  disableForAuthenticationFailure(
    scope: SearchConsoleControlScope,
  ): Promise<{ disabled: true; recommendationId: string }>;
}

type ControlTransaction = Pick<
  Prisma.TransactionClient,
  "analysisRun" | "integration" | "recommendation"
>;
type ControlDatabase = Pick<PrismaClient, "$transaction">;

function resourceNotFound(): never {
  throw new SearchConsoleControlError("RESOURCE_NOT_FOUND");
}

function recommendationId(scope: SearchConsoleControlScope) {
  const digest = createHash("sha256")
    .update(`${scope.runId}\u0000${scope.integrationId}`)
    .digest("hex");
  return `sc-auth-${digest.slice(0, 40)}`;
}

async function findOwnedRun(tx: ControlTransaction, scope: SearchConsoleControlScope) {
  const run = await tx.analysisRun.findFirst({
    where: {
      id: scope.runId,
      clientId: scope.clientId,
      brandId: scope.brandId,
      siteId: scope.siteId,
      siteMarketId: scope.siteMarketId,
      source: "search-console",
    },
    select: { id: true },
  });
  if (run === null) resourceNotFound();
}

async function findOwnedIntegration(
  tx: ControlTransaction,
  scope: SearchConsoleControlScope,
  requireEnabled: boolean,
) {
  const integration = await tx.integration.findFirst({
    where: {
      id: scope.integrationId,
      siteId: scope.siteId,
      siteMarketId: scope.siteMarketId,
      type: "search_console",
      endpoint: scope.property,
      ...(requireEnabled ? { healthState: { not: "disabled" } } : {}),
      site: {
        brandId: scope.brandId,
        brand: { clientId: scope.clientId },
      },
    },
    select: { id: true, secretRef: true },
  });
  if (integration === null) resourceNotFound();
  return integration;
}

export class PrismaSearchConsoleControlRepository implements SearchConsoleControlRepository {
  constructor(private readonly database: ControlDatabase = db) {}

  async getCredentialReference(scope: SearchConsoleControlScope): Promise<SecretRef> {
    return this.database.$transaction(async (tx) => {
      await findOwnedRun(tx, scope);
      const integration = await findOwnedIntegration(tx, scope, true);
      if (integration.secretRef === null || !integration.secretRef.startsWith("file:")) {
        throw new SearchConsoleControlError("CREDENTIAL_UNAVAILABLE");
      }
      return integration.secretRef as SecretRef;
    });
  }

  async disableForAuthenticationFailure(
    scope: SearchConsoleControlScope,
  ): Promise<{ disabled: true; recommendationId: string }> {
    return this.database.$transaction(async (tx) => {
      await findOwnedRun(tx, scope);
      const integration = await findOwnedIntegration(tx, scope, false);
      const id = recommendationId(scope);
      await tx.integration.update({
        where: { id: integration.id },
        data: { healthState: "disabled", lastCheckedAt: new Date() },
      });
      await tx.recommendation.upsert({
        where: { id },
        create: {
          id,
          runId: scope.runId,
          clientId: scope.clientId,
          siteId: scope.siteId,
          title: "Refresh Search Console authorization",
          detail: "Search Console rejected the configured authorization. Refresh the integration credential before the next sync.",
          priority: 10,
          formulaVersion: "search-console-auth-v1",
        },
        update: {},
      });
      return { disabled: true, recommendationId: id };
    });
  }
}

export class SearchConsoleControlPlane {
  constructor(
    private readonly repository: SearchConsoleControlRepository,
    private readonly secrets: SecretResolver,
  ) {}

  async getCredential(scope: SearchConsoleControlScope) {
    const reference = await this.repository.getCredentialReference(scope);
    try {
      const token = await this.secrets.resolve(reference);
      if (token.length === 0) throw new Error("empty credential");
      return { token };
    } catch {
      throw new SearchConsoleControlError("CREDENTIAL_UNAVAILABLE");
    }
  }

  disableAfterAuthenticationFailure(scope: SearchConsoleControlScope) {
    return this.repository.disableForAuthenticationFailure(scope);
  }
}

export function createDefaultSearchConsoleControlPlane() {
  return new SearchConsoleControlPlane(
    new PrismaSearchConsoleControlRepository(),
    new FileSecretResolver(),
  );
}
