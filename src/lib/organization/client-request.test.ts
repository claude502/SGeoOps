import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { middleware } from "../../../middleware";
import { buildCreateClientRequest } from "@/lib/organization/client-request";

const credentials = `Basic ${Buffer.from("ops:secret").toString("base64")}`;

function middlewareRequest(
  requestInit: ReturnType<typeof buildCreateClientRequest>,
  includeActionHeader: boolean,
) {
  const headers = new Headers(requestInit.headers);
  headers.set("authorization", credentials);
  headers.set(
    "x-forwarded-for",
    includeActionHeader ? "198.51.100.20" : "198.51.100.21",
  );
  if (!includeActionHeader) {
    headers.delete("x-geo-ops-action");
  }

  return new NextRequest("http://localhost/api/clients", {
    ...requestInit,
    headers,
  });
}

describe("client creation request", () => {
  beforeEach(() => {
    vi.stubEnv("GEO_OPS_AUTH_ENABLED", "true");
    vi.stubEnv("GEO_OPS_ADMIN_USERNAME", "ops");
    vi.stubEnv("GEO_OPS_ADMIN_PASSWORD", "secret");
    vi.stubEnv("GEO_OPS_REQUIRE_ACTION_HEADER", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes the current Basic Auth middleware with the action header", () => {
    const requestInit = buildCreateClientRequest({
      name: "Client A",
      slug: "client-a",
      active: true,
    });

    const response = middleware(middlewareRequest(requestInit, true));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("is rejected by the current Basic Auth middleware without the header", async () => {
    const requestInit = buildCreateClientRequest({
      name: "Client A",
      slug: "client-a",
      active: true,
    });

    const response = middleware(middlewareRequest(requestInit, false));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Missing x-geo-ops-action header for write request.",
    });
  });
});
