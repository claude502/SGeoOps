import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  FileSecretResolver,
  type SecretRef,
  type SecretResolver,
} from "@/lib/integrations/secret-resolver";
import { parseMatomoOrigin } from "@/lib/matomo/origin";
import { db } from "@/lib/prisma";

export type MatomoControlScope = {
  runId: string;
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
  integrationId: string;
  endpoint: string;
};

export type MatomoControlErrorCode =
  | "RESOURCE_NOT_FOUND"
  | "CREDENTIAL_UNAVAILABLE";

export class MatomoControlError extends Error {
  constructor(readonly code: MatomoControlErrorCode) {
    super(code);
    this.name = "MatomoControlError";
  }
}

export interface MatomoControlRepository {
  getCredentialReference(scope: MatomoControlScope): Promise<SecretRef>;
  disableForAuthenticationFailure(
    scope: MatomoControlScope,
  ): Promise<{ disabled: true; recommendationId: string }>;
}

type ControlTransaction = Pick<
  Prisma.TransactionClient,
  "analysisRun" | "integration" | "recommendation"
>;
type ControlDatabase = Pick<PrismaClient, "$transaction">;

function resourceNotFound(): never {
  throw new MatomoControlError("RESOURCE_NOT_FOUND");
}

function safeFileSecretReference(value: string | null): value is SecretRef {
  if (value === null || !value.startsWith("file:")) return false;
  const path = value.slice("file:".length);
  return path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\u0000") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function recommendationId(scope: MatomoControlScope) {
  const digest = createHash("sha256")
    .update(`${scope.runId}\u0000${scope.integrationId}`)
    .digest("hex");
  return `matomo-auth-${digest.slice(0, 40)}`;
}

async function findOwnedRun(tx: ControlTransaction, scope: MatomoControlScope) {
  const run = await tx.analysisRun.findFirst({
    where: {
      id: scope.runId,
      clientId: scope.clientId,
      brandId: scope.brandId,
      siteId: scope.siteId,
      siteMarketId: scope.siteMarketId,
      source: "matomo",
    },
    select: { id: true },
  });
  if (run === null) resourceNotFound();
}

async function findOwnedIntegration(
  tx: ControlTransaction,
  scope: MatomoControlScope,
  requireEnabled: boolean,
) {
  const endpoint = parseMatomoOrigin(scope.endpoint);
  if (endpoint === null) resourceNotFound();
  const integration = await tx.integration.findFirst({
    where: {
      id: scope.integrationId,
      siteId: scope.siteId,
      siteMarketId: scope.siteMarketId,
      type: "matomo",
      endpoint,
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

export class PrismaMatomoControlRepository implements MatomoControlRepository {
  constructor(private readonly database: ControlDatabase = db) {}

  async getCredentialReference(scope: MatomoControlScope): Promise<SecretRef> {
    return this.database.$transaction(async (tx) => {
      await findOwnedRun(tx, scope);
      const integration = await findOwnedIntegration(tx, scope, true);
      if (!safeFileSecretReference(integration.secretRef)) {
        throw new MatomoControlError("CREDENTIAL_UNAVAILABLE");
      }
      return integration.secretRef;
    });
  }

  async disableForAuthenticationFailure(
    scope: MatomoControlScope,
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
          title: "Refresh Matomo authorization",
          detail: "Matomo rejected the configured reporting token. Refresh the integration credential before the next sync.",
          priority: 10,
          formulaVersion: "matomo-auth-v1",
        },
        update: {},
      });
      return { disabled: true, recommendationId: id };
    });
  }
}

export class MatomoControlPlane {
  constructor(
    private readonly repository: MatomoControlRepository,
    private readonly secrets: SecretResolver,
  ) {}

  async getCredential(scope: MatomoControlScope) {
    const reference = await this.repository.getCredentialReference(scope);
    try {
      const token = await this.secrets.resolve(reference);
      if (token.length === 0) throw new Error("empty credential");
      return { token };
    } catch {
      throw new MatomoControlError("CREDENTIAL_UNAVAILABLE");
    }
  }

  disableAfterAuthenticationFailure(scope: MatomoControlScope) {
    return this.repository.disableForAuthenticationFailure(scope);
  }
}

export function createDefaultMatomoControlPlane() {
  return new MatomoControlPlane(
    new PrismaMatomoControlRepository(),
    new FileSecretResolver(),
  );
}
