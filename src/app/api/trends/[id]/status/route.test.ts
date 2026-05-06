import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();

vi.stubGlobal("fetch", mockFetch);

vi.mock("@/lib/prisma", () => ({
  db: {
    trendTopic: {
      findUnique: mockFindUnique,
      update: mockUpdate,
    },
  },
}));

describe("PATCH /api/trends/[id]/status", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.TRIGGER_API_URL = "http://trigger-dev:3000";
    process.env.TRIGGER_WORKER_API_KEY = "test-api-key";
    process.env.TRIGGER_PROJECT_REF = "proj_geo_ops";
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
  });

  it("returns 404 when the topic does not exist", async () => {
    mockFindUnique.mockResolvedValue(null);

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

  it("does not emit an event when the topic is rejected", async () => {
    mockFindUnique.mockResolvedValue({
      id: "topic_reject",
      keyword: "LHDN e-Invoice deadline",
      platform: "linkedin",
    });
    mockUpdate.mockResolvedValue({
      id: "topic_reject",
      keyword: "LHDN e-Invoice deadline",
      platform: "linkedin",
      status: "rejected",
    });

    const { PATCH } = await import("./route");
    const response = await PATCH(
      new Request("http://localhost/api/trends/topic_reject/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "rejected" }),
      }),
      { params: Promise.resolve({ id: "topic_reject" }) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("emits trend.approved when the topic is approved", async () => {
    mockFindUnique.mockResolvedValue({
      id: "topic_approve",
      keyword: "LHDN e-Invoice deadline",
      platform: "linkedin",
    });
    mockUpdate.mockResolvedValue({
      id: "topic_approve",
      keyword: "LHDN e-Invoice deadline",
      platform: "linkedin",
      status: "approved",
    });
    mockFetch.mockResolvedValue(new Response(null, { status: 202 }));

    const { PATCH } = await import("./route");
    const response = await PATCH(
      new Request("http://localhost/api/trends/topic_approve/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      }),
      { params: Promise.resolve({ id: "topic_approve" }) },
    );

    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/events");
    expect(init.method).toBe("POST");
    expect(init.body).toContain("trend.approved");
    expect(init.body).toContain("topic_approve");
    expect(init.body).toContain("LHDN e-Invoice deadline");
  });
});
