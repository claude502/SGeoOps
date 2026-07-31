import type { AccessScope } from "@/lib/authorization";

export function scopedClientIds(scope: AccessScope): string[] {
  return [...new Set(scope.clientIds.filter((id) => id.trim().length > 0))];
}

export function scopedClientWhere(scope: AccessScope) {
  return {
    workspaceId: scope.workspaceId,
    id: { in: scopedClientIds(scope) },
  };
}

export function scopedClientRelation(scope: AccessScope) {
  return scopedClientWhere(scope);
}
