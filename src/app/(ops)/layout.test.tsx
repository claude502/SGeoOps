import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  headers: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: mocks.getSession,
    },
  },
}));

import OperationsLayout from "./layout";

describe("OperationsLayout", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated operations pages to login", async () => {
    mocks.headers.mockResolvedValue(new Headers());
    mocks.getSession.mockResolvedValue(null);
    mocks.redirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(OperationsLayout({ children: null })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });
});
