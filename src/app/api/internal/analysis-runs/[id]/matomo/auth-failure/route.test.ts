import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInternalRequest } from "@sgeo/internal-protocol";
import { MatomoControlError } from "@/lib/matomo/control-plane";
import { createMatomoAuthFailureRoute } from "./route";

const secret = "matomo-auth-failure-test-secret";
const runId = "run_1";
const pathname = `/api/internal/analysis-runs/${runId}/matomo/auth-failure`;
const originalSecret = process.env.SGEO_INTERNAL_SECRET;
const body = {
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: null,
  integrationId: "integration_1",
  endpoint: "https://analytics.example",
};

async function signedRequest(payload: unknown = body, raw?: string) {
  const bytes = raw ?? JSON.stringify(payload);
  const signed = await signInternalRequest(secret, "POST", pathname, bytes);
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sgeo-timestamp": signed.timestamp,
      "x-sgeo-signature": signed.signature,
    },
    body: bytes,
  });
}

beforeEach(() => { process.env.SGEO_INTERNAL_SECRET = secret; });
afterEach(() => {
  if (originalSecret === undefined) delete process.env.SGEO_INTERNAL_SECRET;
  else process.env.SGEO_INTERNAL_SECRET = originalSecret;
});

describe("POST /api/internal/analysis-runs/[id]/matomo/auth-failure", () => {
  it("uses the signed full scope for idempotent disable and recommendation creation", async () => {
    const control = {
      disableAfterAuthenticationFailure: vi.fn().mockResolvedValue({
        disabled: true,
        recommendationId: "matomo-auth-deterministic",
      }),
    };
    const post = createMatomoAuthFailureRoute(() => control);
    const first = await post(await signedRequest(), { params: Promise.resolve({ id: runId }) });
    const second = await post(await signedRequest(), { params: Promise.resolve({ id: runId }) });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(control.disableAfterAuthenticationFailure).toHaveBeenCalledWith({ runId, ...body });
  });

  it("verifies malformed signed JSON and rejects forged or scope-mismatched requests before mutation", async () => {
    const control = { disableAfterAuthenticationFailure: vi.fn() };
    const post = createMatomoAuthFailureRoute(() => control);
    const validMalformed = await post(await signedRequest(null, "{"), {
      params: Promise.resolve({ id: runId }),
    });
    const forgedRequest = await signedRequest(null, "{");
    forgedRequest.headers.set("x-sgeo-signature", "0".repeat(64));
    const forged = await post(forgedRequest, { params: Promise.resolve({ id: runId }) });
    const badScope = await post(await signedRequest({ ...body, clientId: "client_2", extra: true }), {
      params: Promise.resolve({ id: runId }),
    });

    expect(validMalformed.status).toBe(400);
    expect(forged.status).toBe(401);
    expect(badScope.status).toBe(400);
    expect(control.disableAfterAuthenticationFailure).not.toHaveBeenCalled();
  });

  it("returns the same non-enumerating response for cross-scope resources", async () => {
    const control = {
      disableAfterAuthenticationFailure: vi.fn().mockRejectedValue(
        new MatomoControlError("RESOURCE_NOT_FOUND"),
      ),
    };
    const post = createMatomoAuthFailureRoute(() => control);
    const response = await post(await signedRequest(), { params: Promise.resolve({ id: runId }) });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "CONTROL_SCOPE_NOT_FOUND" });
  });
});
