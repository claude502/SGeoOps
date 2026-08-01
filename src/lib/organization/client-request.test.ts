import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { middleware } from "../../../middleware";
import { buildCreateClientRequest } from "@/lib/organization/client-request";

function middlewareRequest(requestInit: ReturnType<typeof buildCreateClientRequest>) {
  const headers = new Headers(requestInit.headers);

  return new NextRequest("http://localhost/api/clients", {
    ...requestInit,
    headers,
  });
}

describe("client creation request", () => {
  it("uses only the JSON request contract because session auth is cookie-based", () => {
    const requestInit = buildCreateClientRequest({
      name: "Client A",
      slug: "client-a",
      active: true,
    });

    expect(requestInit.headers).toEqual({
      "content-type": "application/json",
    });

    const response = middleware(middlewareRequest(requestInit));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
