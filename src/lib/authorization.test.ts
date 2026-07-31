import { describe, expect, it, vi } from "vitest";
import {
  AuthorizationError,
  assertClientAccess,
  requireAccessScope,
  requireRole,
  resolveAccessScope,
  type AccessScope,
  type AccessScopeDependencies,
  type WorkspaceMembership,
} from "@/lib/authorization";

const operator: AccessScope = {
  actorId: "user_1",
  workspaceId: "workspace_internal",
  role: "Operator",
  clientIds: ["client_a"],
};

const internalMembership: WorkspaceMembership = {
  workspaceId: "workspace_internal",
  role: "Operator",
  workspace: {
    clients: [{ id: "client_a" }],
  },
};

function captureAuthorizationError(operation: () => unknown) {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorizationError);
    return error as AuthorizationError;
  }

  throw new Error("EXPECTED_AUTHORIZATION_ERROR");
}

describe("role authorization", () => {
  it("allows an operator to use an owned client", () => {
    expect(assertClientAccess(operator, "client_a")).toBeUndefined();
  });

  it("rejects another client's data without exposing whether it exists", () => {
    const error = captureAuthorizationError(() =>
      assertClientAccess(operator, "client_b"),
    );

    expect(error).toMatchObject({
      name: "AuthorizationError",
      code: "CLIENT_FORBIDDEN",
      message: "CLIENT_FORBIDDEN",
    });
  });

  it("requires an Admin or Reviewer for approval", () => {
    const error = captureAuthorizationError(() =>
      requireRole(operator, ["Admin", "Reviewer"]),
    );

    expect(error.code).toBe("ROLE_FORBIDDEN");
  });

  it("fails closed when no roles are allowed", () => {
    expect(() => requireRole(operator, [])).toThrow("ROLE_FORBIDDEN");
  });

  it("prevents a Viewer from writing or approving", () => {
    const viewer: AccessScope = { ...operator, role: "Viewer" };

    expect(() => requireRole(viewer, ["Admin", "Operator"])).toThrow(
      "ROLE_FORBIDDEN",
    );
    expect(() => requireRole(viewer, ["Admin", "Reviewer"])).toThrow(
      "ROLE_FORBIDDEN",
    );
  });

  it("allows an Admin when Admin is an explicitly allowed role", () => {
    const admin: AccessScope = { ...operator, role: "Admin" };

    expect(requireRole(admin, ["Admin", "Reviewer"])).toBeUndefined();
  });

  it("does not grant access through empty or duplicate client IDs", () => {
    const scope: AccessScope = {
      ...operator,
      clientIds: ["", "client_a", "client_a"],
    };

    expect(assertClientAccess(scope, "client_a")).toBeUndefined();
    expect(() => assertClientAccess(scope, "")).toThrow("CLIENT_FORBIDDEN");
    expect(() => assertClientAccess(scope, "client")).toThrow("CLIENT_FORBIDDEN");
  });
});

describe("access scope resolution", () => {
  it("builds a normalized scope from one membership", () => {
    const scope = resolveAccessScope("user_1", [
      {
        ...internalMembership,
        workspace: {
          clients: [{ id: "" }, { id: "client_a" }, { id: "client_a" }],
        },
      },
    ]);

    expect(scope).toEqual({
      actorId: "user_1",
      workspaceId: "workspace_internal",
      role: "Operator",
      clientIds: ["client_a"],
    });
  });

  it("fails closed when a user has no workspace membership", () => {
    expect(() => resolveAccessScope("user_1", [])).toThrow(
      "WORKSPACE_FORBIDDEN",
    );
  });

  it("fails closed for a membership outside the internal workspace", () => {
    expect(() =>
      resolveAccessScope("user_1", [
        { ...internalMembership, workspaceId: "workspace_other" },
      ]),
    ).toThrow("WORKSPACE_FORBIDDEN");
  });

  it("fails closed instead of choosing between multiple memberships", () => {
    const otherMembership: WorkspaceMembership = {
      ...internalMembership,
      workspaceId: "workspace_other",
    };

    expect(() =>
      resolveAccessScope("user_1", [internalMembership, otherMembership]),
    ).toThrow("WORKSPACE_FORBIDDEN");
  });

  it("rejects an unauthenticated request before loading memberships", async () => {
    const dependencies: AccessScopeDependencies = {
      getSession: vi.fn().mockResolvedValue(null),
      findMemberships: vi.fn(),
    };

    await expect(
      requireAccessScope(new Request("https://geo.example.com"), dependencies),
    ).rejects.toThrow("UNAUTHENTICATED");
    expect(dependencies.findMemberships).not.toHaveBeenCalled();
  });

  it("uses only repository-owned clients and ignores request client input", async () => {
    const dependencies: AccessScopeDependencies = {
      getSession: vi.fn().mockResolvedValue({ user: { id: "user_1" } }),
      findMemberships: vi.fn().mockResolvedValue([internalMembership]),
    };

    const scope = await requireAccessScope(
      new Request("https://geo.example.com/?clientId=client_b"),
      dependencies,
    );

    expect(scope.clientIds).toEqual(["client_a"]);
    expect(() => assertClientAccess(scope, "client_b")).toThrow(
      "CLIENT_FORBIDDEN",
    );
  });
});
