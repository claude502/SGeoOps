import { describe, expect, it, vi } from "vitest";
import {
  bootstrapAdmin,
  readBootstrapAdminInput,
  type BootstrapAdminInput,
  type BootstrapDependencies,
  type BootstrapTransaction,
} from "./bootstrap-admin";

const input: BootstrapAdminInput = {
  email: "admin@example.com",
  name: "Platform Admin",
  password: "a-secure-bootstrap-password",
};

describe("bootstrap admin input", () => {
  it("requires email, name, and password", () => {
    expect(() => readBootstrapAdminInput({})).toThrow(
      "BOOTSTRAP_ENV_REQUIRED",
    );
    expect(() =>
      readBootstrapAdminInput({
        SGEO_BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
        SGEO_BOOTSTRAP_ADMIN_NAME: "Platform Admin",
        SGEO_BOOTSTRAP_ADMIN_PASSWORD: " ",
      }),
    ).toThrow("BOOTSTRAP_ENV_REQUIRED");
  });

  it("returns normalized non-secret fields without changing the password", () => {
    expect(
      readBootstrapAdminInput({
        SGEO_BOOTSTRAP_ADMIN_EMAIL: " Admin@Example.com ",
        SGEO_BOOTSTRAP_ADMIN_NAME: " Platform Admin ",
        SGEO_BOOTSTRAP_ADMIN_PASSWORD: "  password-with-spaces  ",
      }),
    ).toEqual({
      email: "admin@example.com",
      name: "Platform Admin",
      password: "  password-with-spaces  ",
    });
  });
});

describe("bootstrap admin transaction", () => {
  it("refuses to bootstrap when any user already exists", async () => {
    const signUpEmail = vi.fn();
    const createMembership = vi.fn();
    const dependencies: BootstrapDependencies = {
      transaction: async (operation) =>
        operation({
          countUsers: async () => 1,
          findInternalWorkspace: vi.fn(),
          signUpEmail,
          createMembership,
        }),
    };

    await expect(bootstrapAdmin(input, dependencies)).rejects.toThrow(
      "BOOTSTRAP_ALREADY_COMPLETED",
    );
    expect(signUpEmail).not.toHaveBeenCalled();
    expect(createMembership).not.toHaveBeenCalled();
  });

  it("creates the user and Admin membership in one transaction", async () => {
    const createMembership = vi.fn();
    const dependencies: BootstrapDependencies = {
      transaction: async (operation) =>
        operation({
          countUsers: async () => 0,
          findInternalWorkspace: async () => ({ id: "workspace_internal" }),
          signUpEmail: async () => ({ user: { id: "user_admin" } }),
          createMembership,
        }),
    };

    await expect(bootstrapAdmin(input, dependencies)).resolves.toEqual({
      userId: "user_admin",
    });
    expect(createMembership).toHaveBeenCalledWith({
      workspaceId: "workspace_internal",
      userId: "user_admin",
      role: "Admin",
    });
  });

  it("rolls back the created user when membership creation fails", async () => {
    const committed = {
      users: [] as string[],
      memberships: [] as string[],
    };
    const transaction: BootstrapDependencies["transaction"] = async (
      operation,
    ) => {
      const draft = structuredClone(committed);
      const tx: BootstrapTransaction = {
        countUsers: async () => draft.users.length,
        findInternalWorkspace: async () => ({ id: "workspace_internal" }),
        signUpEmail: async () => {
          draft.users.push("user_admin");
          return { user: { id: "user_admin" } };
        },
        createMembership: async () => {
          throw new Error("MEMBERSHIP_WRITE_FAILED");
        },
      };

      const result = await operation(tx);
      committed.users = draft.users;
      committed.memberships = draft.memberships;
      return result;
    };

    await expect(bootstrapAdmin(input, { transaction })).rejects.toThrow(
      "MEMBERSHIP_WRITE_FAILED",
    );
    expect(committed).toEqual({ users: [], memberships: [] });
  });
});
