import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInternalRequest } from "@sgeo/internal-protocol";
import { MatomoControlError } from "@/lib/matomo/control-plane";
import { createMatomoCredentialRoute } from "./route";

const secret = "matomo-control-test-secret";
const runId = "run_1";
const pathname = `/api/internal/analysis-runs/${runId}/matomo/credential`;
const originalSecret = process.env.SGEO_INTERNAL_SECRET;
const body = {
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: null,
  integrationId: "integration_1",
  endpoint: "https://analytics.example/",
};

async function signedRequest(payload: unknown = body, signedPath = pathname, raw?: string) {
  const bytes = raw ?? JSON.stringify(payload);
  const signed = await signInternalRequest(secret, "POST", signedPath, bytes);
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

describe("POST /api/internal/analysis-runs/[id]/matomo/credential", () => {
  it("returns a token only for a signed canonical owned scope", async () => {
    const control = { getCredential: vi.fn().mockResolvedValue({ token: "matomo-token" }) };
    const post = createMatomoCredentialRoute(() => control);
    const response = await post(await signedRequest(), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ token: "matomo-token" });
    expect(control.getCredential).toHaveBeenCalledWith({
      runId,
      ...body,
      endpoint: "https://analytics.example",
    });
  });

  it("verifies the body digest before returning a parse error for malformed JSON", async () => {
    const control = { getCredential: vi.fn() };
    const post = createMatomoCredentialRoute(() => control);

    const response = await post(await signedRequest(null, pathname, "{"), {
      params: Promise.resolve({ id: runId }),
    });
    const forgedRequest = await signedRequest(null, pathname, "{");
    forgedRequest.headers.set("x-sgeo-signature", "0".repeat(64));
    const forged = await post(forgedRequest, { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(400);
    expect(forged.status).toBe(401);
    expect(control.getCredential).not.toHaveBeenCalled();
  });

  it("rejects a signature replayed from another route", async () => {
    const control = { getCredential: vi.fn() };
    const post = createMatomoCredentialRoute(() => control);
    const response = await post(
      await signedRequest(body, `/api/internal/analysis-runs/${runId}/matomo/auth-failure`),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(response.status).toBe(401);
    expect(control.getCredential).not.toHaveBeenCalled();
  });

  it("does not enumerate disabled, cross-client, or unavailable credentials", async () => {
    const control = {
      getCredential: vi.fn().mockRejectedValue(new MatomoControlError("RESOURCE_NOT_FOUND")),
    };
    const post = createMatomoCredentialRoute(() => control);
    const response = await post(await signedRequest(), { params: Promise.resolve({ id: runId }) });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "CONTROL_SCOPE_NOT_FOUND" });
  });
});
