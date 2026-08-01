import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessScope } from "@/lib/authorization";

const mocks = vi.hoisted(() => ({
  requireAccessScope: vi.fn(),
  listClientSiteOverviews: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("@/lib/authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authorization")>()),
  requireAccessScope: mocks.requireAccessScope,
}));

vi.mock("@/lib/organization/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organization/repository")>()),
  organizationRepository: {
    listClientSiteOverviews: mocks.listClientSiteOverviews,
    createClient: mocks.createClient,
  },
}));

const operator: AccessScope = {
  actorId: "operator_a",
  workspaceId: "workspace_internal",
  role: "Operator",
  clientIds: ["client_a"],
};

describe("/api/clients", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.requireAccessScope.mockResolvedValue(operator);
  });

  it("returns a session-scoped client list to read-only roles", async () => {
    const client = {
      id: "client_a",
      workspaceId: "workspace_internal",
      name: "Client A",
      slug: "client-a",
      active: true,
      createdAt: new Date("2026-07-31T00:00:00.000Z"),
      updatedAt: new Date("2026-07-31T00:00:00.000Z"),
    };
    mocks.requireAccessScope.mockResolvedValue({ ...operator, role: "Viewer" });
    mocks.listClientSiteOverviews.mockResolvedValue([{ ...client, sites: [] }]);
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost/api/clients"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      clients: [
        {
          ...client,
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T00:00:00.000Z",
          sites: [],
        },
      ],
      permissions: {
        canCreateClient: false,
      },
    });
    expect(mocks.listClientSiteOverviews).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "operator_a", role: "Viewer" }),
    );
  });

  it("reports client creation permission for Admin", async () => {
    mocks.requireAccessScope.mockResolvedValue({ ...operator, role: "Admin" });
    mocks.listClientSiteOverviews.mockResolvedValue([]);
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost/api/clients"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      clients: [],
      permissions: {
        canCreateClient: true,
      },
    });
  });

  it("returns 401 when the request has no session", async () => {
    const { AuthorizationError } = await import("@/lib/authorization");
    mocks.requireAccessScope.mockRejectedValue(
      new AuthorizationError("UNAUTHENTICATED"),
    );
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost/api/clients"));

    expect(response.status).toBe(401);
    expect(mocks.listClientSiteOverviews).not.toHaveBeenCalled();
  });

  it("allows only Admin to create a client", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Client B", slug: "client-b" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("rejects unknown ownership fields before repository access", async () => {
    mocks.requireAccessScope.mockResolvedValue({ ...operator, role: "Admin" });
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Client B",
          slug: "client-b",
          workspaceId: "workspace_attacker",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("creates a normalized client and maps uniqueness conflicts to 409", async () => {
    mocks.requireAccessScope.mockResolvedValue({ ...operator, role: "Admin" });
    mocks.createClient.mockRejectedValueOnce({ code: "P2002" });
    const { POST } = await import("./route");
    const request = () =>
      new Request("http://localhost/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: " Client B ", slug: "Client-B" }),
      });

    const conflict = await POST(request());
    expect(conflict.status).toBe(409);

    mocks.createClient.mockResolvedValueOnce({
      id: "client_b",
      workspaceId: "workspace_internal",
      name: "Client B",
      slug: "client-b",
      active: true,
      createdAt: new Date("2026-07-31T00:00:00.000Z"),
      updatedAt: new Date("2026-07-31T00:00:00.000Z"),
    });
    const created = await POST(request());

    expect(created.status).toBe(201);
    expect(mocks.createClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: "Admin" }),
      { name: "Client B", slug: "client-b", active: true },
    );
  });
});
