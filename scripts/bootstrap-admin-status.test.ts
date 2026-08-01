import { describe, expect, it } from "vitest";

import { runBootstrapAdminStatusCli } from "./bootstrap-admin-status";

describe("runBootstrapAdminStatusCli", () => {
  it("accepts a database with an internal Workspace Administrator", async () => {
    const inputs: Array<{
      where: { workspaceId: string; role: "Admin" };
    }> = [];
    const count = async (input: (typeof inputs)[number]) => {
      inputs.push(input);
      return 1;
    };
    let disconnected = false;

    await expect(
      runBootstrapAdminStatusCli(async () => ({
        workspaceMember: { count },
        $disconnect: async () => {
          disconnected = true;
        },
      })),
    ).resolves.toEqual({ adminCount: 1 });

    expect(disconnected).toBe(true);
    expect(inputs).toEqual([
      {
        where: {
          workspaceId: "workspace_internal",
          role: "Admin",
        },
      },
    ]);
  });

  it("fails closed and disconnects when no internal Workspace Administrator exists", async () => {
    let disconnected = false;

    await expect(
      runBootstrapAdminStatusCli(async () => ({
        workspaceMember: { count: async () => 0 },
        $disconnect: async () => {
          disconnected = true;
        },
      })),
    ).rejects.toThrow("BOOTSTRAP_ADMIN_REQUIRED");

    expect(disconnected).toBe(true);
  });

  it("disconnects without accepting startup when status cannot be read", async () => {
    let disconnected = false;

    await expect(
      runBootstrapAdminStatusCli(async () => ({
        workspaceMember: {
          count: async () => {
            throw new Error("DATABASE_UNAVAILABLE");
          },
        },
        $disconnect: async () => {
          disconnected = true;
        },
      })),
    ).rejects.toThrow("DATABASE_UNAVAILABLE");

    expect(disconnected).toBe(true);
  });
});
