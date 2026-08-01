import type { Prisma } from "@prisma/client";

import type { GeoFlowTaskLinkView, GeoFlowTaskStatus } from "@/types/geo";

export const publicGeoFlowLinkSelect = {
  id: true,
  contentAssetId: true,
  geoFlowTaskId: true,
  geoFlowJobId: true,
  geoFlowArticleId: true,
  geoFlowArticleUrl: true,
  status: true,
  lastSyncedAt: true,
  lastError: true,
  idempotencyKey: true,
} satisfies Prisma.GeoFlowTaskLinkSelect;

export type PublicGeoFlowLinkInput = Omit<
  GeoFlowTaskLinkView,
  "lastSyncedAt"
> & {
  lastSyncedAt: Date | string | null;
  status: GeoFlowTaskStatus;
};

const geoFlowErrorCodes = new Set([
  "GEOFLOW_CREATE_FAILED",
  "GEOFLOW_ENQUEUE_FAILED",
  "GEOFLOW_READ_FAILED",
]);

export function stableGeoFlowErrorCode(value: string | null | undefined) {
  if (!value) {
    return value ?? null;
  }
  return geoFlowErrorCodes.has(value) ? value : "GEOFLOW_READ_FAILED";
}

function toIso(value: Date | string | null) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

export function toPublicGeoFlowLink(
  link: PublicGeoFlowLinkInput,
): GeoFlowTaskLinkView {
  return {
    id: link.id,
    contentAssetId: link.contentAssetId,
    geoFlowTaskId: link.geoFlowTaskId,
    geoFlowJobId: link.geoFlowJobId,
    geoFlowArticleId: link.geoFlowArticleId,
    geoFlowArticleUrl: link.geoFlowArticleUrl,
    status: link.status,
    lastSyncedAt: toIso(link.lastSyncedAt),
    lastError: stableGeoFlowErrorCode(link.lastError),
    idempotencyKey: link.idempotencyKey,
  };
}
