import type { Prisma } from "@prisma/client";
import { parseBasicAuthorization } from "@/lib/basic-auth";
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
  if (!isDatabaseConfigured()) {
    return;
  }

  try {
    await getPrisma().auditEvent.create({
      data: {
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
    console.warn("Could not write audit event.", error);
  }
}

export async function listRecentAuditEvents(limit = 20) {
  if (!isDatabaseConfigured()) {
    return [] as AuditEventView[];
  }

  const events = await getPrisma().auditEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, 50)),
  });

  return events.map(mapAuditEvent);
}
