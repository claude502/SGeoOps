import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInternalRequest } from "@sgeo/internal-protocol";
import { SearchConsoleControlError } from "@/lib/search-console/control-plane";
import { createSearchConsoleAuthFailureRoute } from "./route";

const secret = "search-console-auth-failure-test-secret";
const runId = "run_1";
const pathname = `/api/internal/analysis-runs/${runId}/search-console/auth-failure`;
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

describe("POST /api/internal/analysis-runs/[id]/search-console/auth-failure", () => {
  it("uses the signed full scope to make disabled/recommendation creation idempotent", async () => {
    const control = {
      disableAfterAuthenticationFailure: vi.fn().mockResolvedValue({
        disabled: true,
        recommendationId: "sc-auth-deterministic",
      }),
    };
    const post = createSearchConsoleAuthFailureRoute(() => control);

    const first = await post(await signedRequest(), { params: Promise.resolve({ id: runId }) });
    const second = await post(await signedRequest(), { params: Promise.resolve({ id: runId }) });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(control.disableAfterAuthenticationFailure).toHaveBeenCalledTimes(2);
    expect(control.disableAfterAuthenticationFailure).toHaveBeenCalledWith({ runId, ...body });
  });

  it("rejects unsigned and malformed requests before mutating an integration", async () => {
    const control = { disableAfterAuthenticationFailure: vi.fn() };
    const post = createSearchConsoleAuthFailureRoute(() => control);
    const unsigned = new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const unsignedResponse = await post(unsigned, { params: Promise.resolve({ id: runId }) });
    const malformedResponse = await post(
      await signedRequest({ ...body, integrationId: "", extra: true }),
      { params: Promise.resolve({ id: runId }) },
    );

    expect(unsignedResponse.status).toBe(401);
    expect(malformedResponse.status).toBe(400);
    expect(control.disableAfterAuthenticationFailure).not.toHaveBeenCalled();
  });

  it("does not enumerate a missing or cross-scope integration", async () => {
    const control = {
      disableAfterAuthenticationFailure: vi.fn()
        .mockRejectedValue(new SearchConsoleControlError("RESOURCE_NOT_FOUND")),
    };
    const post = createSearchConsoleAuthFailureRoute(() => control);

    const response = await post(await signedRequest(), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Search Console control scope not found",
      code: "CONTROL_SCOPE_NOT_FOUND",
    });
  });
});
