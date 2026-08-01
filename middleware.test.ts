import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { middleware } from "./middleware";

function request(url: string, host: string) {
  return new NextRequest(url, {
    headers: { host },
  });
}

describe("request middleware", () => {
  it("allows an unauthenticated Txpuro public guide request", () => {
    const response = middleware(
      request("https://txpuro.com/guides/pricing", "txpuro.com"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("leaves unauthenticated operations requests to the session-protected layout", () => {
    const response = middleware(
      request("https://wingheng.technology/", "wingheng.technology"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not protect the Better Auth login route", () => {
    const response = middleware(
      request("https://wingheng.technology/login", "wingheng.technology"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
