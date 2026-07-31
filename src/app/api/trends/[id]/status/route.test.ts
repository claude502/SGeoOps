import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAccessScope: vi.fn(),
  requireRole: vi.fn(),
  updateTrendStatus: vi.fn(),
}));

const TestAuthorizationError = vi.hoisted(
  () =>
    class TestAuthorizationError extends Error {
      constructor(readonly code: "UNAUTHENTICATED" | "ROLE_FORBIDDEN") {
        super(code);
        this.name = "AuthorizationError";
      }
    },
);

const scope = {
  actorId: "reviewer_a",
  workspaceId: "workspace_internal",
  role: "Reviewer" as const,
  clientIds: ["client_a"],
};

vi.mock("@/lib/authorization", () => ({
  AuthorizationError: TestAuthorizationError,
  requireAccessScope: mocks.requireAccessScope,
  requireRole: mocks.requireRole,
}));

vi.mock("@/lib/business/repository", () => ({
  PrismaBusinessRepository: class {
    updateTrendStatus(
      receivedScope: typeof scope,
      id: string,
      status: "approved" | "rejected",
      request: Request,
    ) {
      return mocks.updateTrendStatus(
        receivedScope,
        id,
        status,
        request,
      );
    }
  },
}));

describe("PATCH /api/trends/[id]/status", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.requireAccessScope.mockResolvedValue(scope);
    mocks.requireRole.mockImplementation((receivedScope, allowedRoles) => {
      if (!allowedRoles.includes(receivedScope.role)) {
        throw new TestAuthorizationError("ROLE_FORBIDDEN");
      }
    });
  });

  it("returns 400 for an invalid status", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(
      new Request("http://localhost/api/trends/topic_1/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "invalid" }),
      }),
      { params: Promise.resolve({ id: "topic_1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.updateTrendStatus).not.toHaveBeenCalled();
  });

  it("returns 404 when the scoped repository cannot find the topic", async () => {
    mocks.updateTrendStatus.mockResolvedValue(null);
    const { PATCH } = await import("./route");
    const response = await PATCH(
      new Request("http://localhost/api/trends/topic_404/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      }),
      { params: Promise.resolve({ id: "topic_404" }) },
    );

    expect(response.status).toBe(404);
  });

  it.each(["approved", "rejected"] as const)(
    "persists %s through the scoped transactional repository",
    async (status) => {
      mocks.updateTrendStatus.mockResolvedValue({
        id: "topic_a",
        clientId: "client_a",
        status,
      });
      const { PATCH } = await import("./route");
      const request = new Request(
        "http://localhost/api/trends/topic_a/status",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      const response = await PATCH(request, {
        params: Promise.resolve({ id: "topic_a" }),
      });

      expect(response.status).toBe(200);
      expect(mocks.requireRole).toHaveBeenCalledWith(scope, [
        "Admin",
        "Reviewer",
      ]);
      expect(mocks.updateTrendStatus).toHaveBeenCalledWith(
        scope,
        "topic_a",
        status,
        request,
      );
    },
  );

  it.each(["Operator", "Viewer"] as const)(
    "returns 403 for the %s role",
    async (role) => {
      mocks.requireAccessScope.mockResolvedValue({ ...scope, role });
      const { PATCH } = await import("./route");
      const response = await PATCH(
        new Request("http://localhost/api/trends/topic_a/status", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "approved" }),
        }),
        { params: Promise.resolve({ id: "topic_a" }) },
      );

      expect(response.status).toBe(403);
      expect(mocks.updateTrendStatus).not.toHaveBeenCalled();
    },
  );

  it("returns 500 when required audit or outbox persistence fails", async () => {
    mocks.updateTrendStatus.mockRejectedValue(
      new Error("required event failed"),
    );
    const { PATCH } = await import("./route");
    const response = await PATCH(
      new Request("http://localhost/api/trends/topic_a/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      }),
      { params: Promise.resolve({ id: "topic_a" }) },
    );

    expect(response.status).toBe(500);
  });
});
