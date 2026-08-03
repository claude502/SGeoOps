import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInternalRequest } from "@sgeo/internal-protocol";
import { SearchConsoleControlError } from "@/lib/search-console/control-plane";
import { createSearchConsoleCredentialRoute } from "./route";

const secret = "search-console-control-test-secret";
const runId = "run_1";
const pathname = `/api/internal/analysis-runs/${runId}/search-console/credential`;
const originalSecret = process.env.SGEO_INTERNAL_SECRET;
const body = {
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: null,
  integrationId: "integration_1",
  property: "sc-domain:shop.example",
};

async function signedRequest(payload: unknown = body) {
  const raw = JSON.stringify(payload);
  const signed = await signInternalRequest(secret, "POST", pathname, raw);
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sgeo-timestamp": signed.timestamp,
      "x-sgeo-signature": signed.signature,
    },
    body: raw,
  });
}

beforeEach(() => {
  process.env.SGEO_INTERNAL_SECRET = secret;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.SGEO_INTERNAL_SECRET;
  else process.env.SGEO_INTERNAL_SECRET = originalSecret;
});

describe("POST /api/internal/analysis-runs/[id]/search-console/credential", () => {
  it("rejects unsigned scope requests before resolving a credential", async () => {
    const control = { getCredential: vi.fn() };
    const post = createSearchConsoleCredentialRoute(() => control);

    const response = await post(new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(401);
    expect(control.getCredential).not.toHaveBeenCalled();
  });

  it("returns a credential only for a signed complete owned scope", async () => {
    const control = { getCredential: vi.fn().mockResolvedValue({ token: "google-token" }) };
    const post = createSearchConsoleCredentialRoute(() => control);

    const response = await post(await signedRequest(), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ token: "google-token" });
    expect(control.getCredential).toHaveBeenCalledWith({ runId, ...body });
  });

  it("fails closed for an unknown or disabled cross-scope integration", async () => {
    const control = {
      getCredential: vi.fn().mockRejectedValue(new SearchConsoleControlError("RESOURCE_NOT_FOUND")),
    };
    const post = createSearchConsoleCredentialRoute(() => control);

    const response = await post(await signedRequest(), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Search Console control scope not found",
      code: "CONTROL_SCOPE_NOT_FOUND",
    });
  });

  it.each([
    [{ ...body, extra: "field" }],
    [{ ...body, siteMarketId: 7 }],
    [{ ...body, property: "https://user:password@shop.example/" }],
    [{ ...body, clientId: "client id" }],
    [null],
  ])("rejects malformed signed bodies without resolving a credential", async (payload) => {
    const control = { getCredential: vi.fn() };
    const post = createSearchConsoleCredentialRoute(() => control);

    const response = await post(await signedRequest(payload), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(400);
    expect(control.getCredential).not.toHaveBeenCalled();
  });

  it("returns unauthorized when a fresh signature does not match malformed JSON", async () => {
    const signed = await signInternalRequest(secret, "POST", pathname, "{}");
    const control = { getCredential: vi.fn() };
    const post = createSearchConsoleCredentialRoute(() => control);
    const request = new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sgeo-timestamp": signed.timestamp,
        "x-sgeo-signature": signed.signature,
      },
      body: "{",
    });

    const response = await post(request, { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(401);
    expect(control.getCredential).not.toHaveBeenCalled();
  });

  it("returns the same non-enumerating result when a secret is absent", async () => {
    const control = {
      getCredential: vi.fn().mockRejectedValue(new SearchConsoleControlError("CREDENTIAL_UNAVAILABLE")),
    };
    const post = createSearchConsoleCredentialRoute(() => control);

    const response = await post(await signedRequest(), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Search Console control scope not found",
      code: "CONTROL_SCOPE_NOT_FOUND",
    });
  });
});
