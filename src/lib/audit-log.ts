import type { Prisma } from "@prisma/client";
import { parseBasicAuthorization } from "@/lib/basic-auth";
import type { AccessScope } from "@/lib/authorization";
import { getPrisma, isDatabaseConfigured } from "@/lib/prisma";
import type { AuditEventView } from "@/types/geo";

type AuditOutcome = "success" | "failure";

export interface AuditEventInput {
  action: string;
  entityType: string;
  entityId?: string | number | null;
  outcome: AuditOutcome;
  request?: Request;
  actor?: string | null;
  metadata?: Record<string, unknown> | null;
  clientId?: string;
  brandId?: string;
  siteId?: string;
  siteMarketId?: string | null;
}

export interface RequiredAuditEventInput {
  actorId: string;
  workspaceId: string;
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  outcome: AuditOutcome;
  request?: Request;
  metadata?: Record<string, unknown> | null;
}

type AuditEventRow = {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: string;
  requestId: string | null;
  metadata: unknown;
  createdAt: Date | string;
};

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

function auditActorFromRequest(request?: Request) {
  if (!request) {
    return "system";
  }

  return parseBasicAuthorization(request.headers.get("authorization"))?.username || "unknown";
}

function requestIdFromRequest(request?: Request) {
  return request?.headers.get("x-request-id") || request?.headers.get("cf-ray") || null;
}

function mapAuditEvent(event: AuditEventRow): AuditEventView {
  return {
    id: event.id,
    actor: event.actor,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    outcome: event.outcome === "failure" ? "failure" : "success",
    requestId: event.requestId,
    metadata: event.metadata,
    createdAt: toIso(event.createdAt),
  };
}

export async function recordAuditEvent(input: AuditEventInput) {
  if (
    !isDatabaseConfigured() ||
    !input.clientId ||
    !input.brandId ||
    !input.siteId
  ) {
    return;
  }

  try {
    await getPrisma().auditEvent.create({
      data: {
        clientId: input.clientId,
        brandId: input.brandId,
        siteId: input.siteId,
        siteMarketId: input.siteMarketId ?? null,
        actor: input.actor || auditActorFromRequest(input.request),
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId === undefined || input.entityId === null ? null : String(input.entityId),
        outcome: input.outcome,
        requestId: requestIdFromRequest(input.request),
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (error) {
    console.warn("Could not write audit event.", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export async function createAuditEvent(
  tx: Prisma.TransactionClient,
  input: RequiredAuditEventInput,
): Promise<void> {
  if (
    !input.actorId ||
    !input.workspaceId ||
    !input.clientId ||
    !input.brandId ||
    !input.siteId
  ) {
    throw new Error("Required audit ownership is incomplete.");
  }

  await tx.auditEvent.create({
    data: {
      clientId: input.clientId,
      brandId: input.brandId,
      siteId: input.siteId,
      siteMarketId: input.siteMarketId ?? null,
      actor: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId:
        input.entityId === undefined || input.entityId === null
          ? null
          : String(input.entityId),
      outcome: input.outcome,
      requestId: requestIdFromRequest(input.request),
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}

export async function listRecentAuditEvents(
  scopeOrLegacyLimit: AccessScope | number,
  requestedLimit = 20,
) {
  if (
    !isDatabaseConfigured() ||
    typeof scopeOrLegacyLimit === "number"
  ) {
    return [] as AuditEventView[];
  }
  const scope = scopeOrLegacyLimit;
  const limit = requestedLimit;

  const events = await getPrisma().auditEvent.findMany({
    where: {
      clientId: { in: scope.clientIds },
      client: { workspaceId: scope.workspaceId },
    },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, 50)),
  });

  return events.map(mapAuditEvent);
}
