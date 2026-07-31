import { auth } from "@/lib/auth";
import { getPrisma } from "@/lib/prisma";

const INTERNAL_WORKSPACE_ID = "workspace_internal";

export type AppRole = "Admin" | "Operator" | "Reviewer" | "Viewer";
export type AuthorizationErrorCode =
  | "UNAUTHENTICATED"
  | "WORKSPACE_FORBIDDEN"
  | "ROLE_FORBIDDEN"
  | "CLIENT_FORBIDDEN";

export interface AccessScope {
  actorId: string;
  workspaceId: string;
  role: AppRole;
  clientIds: string[];
}

export interface WorkspaceMembership {
  workspaceId: string;
  role: AppRole;
  workspace: {
    clients: Array<{ id: string }>;
  };
}

export interface AccessScopeDependencies {
  getSession(headers: Headers): Promise<{ user: { id: string } } | null>;
  findMemberships(userId: string): Promise<WorkspaceMembership[]>;
}

export class AuthorizationError extends Error {
  constructor(readonly code: AuthorizationErrorCode) {
    super(code);
    this.name = "AuthorizationError";
  }
}

export function requireRole(
  scope: AccessScope,
  allowedRoles: readonly AppRole[],
) {
  if (allowedRoles.length === 0 || !allowedRoles.includes(scope.role)) {
    throw new AuthorizationError("ROLE_FORBIDDEN");
  }
}

export function assertClientAccess(scope: AccessScope, clientId: string) {
  if (!clientId || !scope.clientIds.includes(clientId)) {
    throw new AuthorizationError("CLIENT_FORBIDDEN");
  }
}

export function resolveAccessScope(
  actorId: string,
  memberships: readonly WorkspaceMembership[],
): AccessScope {
  if (memberships.length !== 1) {
    throw new AuthorizationError("WORKSPACE_FORBIDDEN");
  }

  const [membership] = memberships;
  if (
    !actorId ||
    membership.workspaceId !== INTERNAL_WORKSPACE_ID
  ) {
    throw new AuthorizationError("WORKSPACE_FORBIDDEN");
  }

  const clientIds = [
    ...new Set(
      membership.workspace.clients
        .map(({ id }) => id)
        .filter((id) => id.trim().length > 0),
    ),
  ];

  return {
    actorId,
    workspaceId: membership.workspaceId,
    role: membership.role,
    clientIds,
  };
}

const defaultDependencies: AccessScopeDependencies = {
  async getSession(headers) {
    return auth.api.getSession({ headers });
  },
  async findMemberships(userId) {
    return getPrisma().workspaceMember.findMany({
      where: { userId },
      orderBy: { workspaceId: "asc" },
      include: {
        workspace: {
          include: {
            clients: {
              select: { id: true },
              orderBy: { id: "asc" },
            },
          },
        },
      },
    });
  },
};

export async function requireAccessScope(
  request: Request,
  dependencies: AccessScopeDependencies = defaultDependencies,
): Promise<AccessScope> {
  const session = await dependencies.getSession(request.headers);
  if (!session) {
    throw new AuthorizationError("UNAUTHENTICATED");
  }

  const memberships = await dependencies.findMemberships(session.user.id);
  return resolveAccessScope(session.user.id, memberships);
}
