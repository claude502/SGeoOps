import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
}));

import TxpuroGuidesPage from "./page";

describe("Txpuro public guides page", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "");
    vi.clearAllMocks();
    mocks.notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the pricing guide anonymously for txpuro.com", async () => {
    const requestHeaders = new Headers({ host: "txpuro.com" });
    mocks.headers.mockResolvedValue(requestHeaders);

    const markup = renderToStaticMarkup(
      await TxpuroGuidesPage({ params: Promise.resolve({ slug: ["pricing"] }) }),
    );

    expect(markup).toContain("Txpuro");
    expect(requestHeaders.get("authorization")).toBeNull();
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("rejects an unknown host", async () => {
    mocks.headers.mockResolvedValue(new Headers({ host: "unknown.example" }));

    await expect(
      TxpuroGuidesPage({ params: Promise.resolve({ slug: ["pricing"] }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
