import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInternalRequest } from "@sgeo/internal-protocol";
import { createSearchConsoleDispatchRoute } from "./route";

const secret = "search-console-dispatch-secret";
const pathname = "/api/internal/analysis-runs/search-console/dispatch";
const originalSecret = process.env.SGEO_INTERNAL_SECRET;
const scheduledAt = "2026-08-04T07:30:00.000Z";
const runs = [{
  runId: "sc-run-1",
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: null,
  integrationId: "integration_1",
  property: "sc-domain:shop.example",
  startDate: "2026-08-01",
  endDate: "2026-08-01",
}];

async function request(body: unknown, signed = true) {
  const serialized = JSON.stringify(body);
  const signature = signed
    ? await signInternalRequest(secret, "POST", pathname, serialized)
    : { timestamp: String(Math.floor(Date.now() / 1_000)), signature: "0".repeat(64) };
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sgeo-timestamp": signature.timestamp,
      "x-sgeo-signature": signature.signature,
    },
    body: serialized,
  });
}

beforeEach(() => {
  process.env.SGEO_INTERNAL_SECRET = secret;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.SGEO_INTERNAL_SECRET;
  else process.env.SGEO_INTERNAL_SECRET = originalSecret;
});

describe("POST /api/internal/analysis-runs/search-console/dispatch", () => {
  it("authenticates the exact body and returns owned no-secret sync payloads", async () => {
    const dispatcher = { dispatch: vi.fn().mockResolvedValue(runs) };
    const post = createSearchConsoleDispatchRoute(() => dispatcher);

    const response = await post(await request({ scheduledAt }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runs });
    expect(dispatcher.dispatch).toHaveBeenCalledWith(new Date(scheduledAt));
    expect(JSON.stringify(runs)).not.toMatch(/secretRef|token|file:/i);
  });

  it.each([
    ["invalid signature", { scheduledAt }, false],
    ["missing timestamp", {}, true],
    ["unexpected scope", { scheduledAt, clientId: "client_2" }, true],
  ])("rejects %s without dispatching", async (_label, body, signed) => {
    const dispatcher = { dispatch: vi.fn() };
    const post = createSearchConsoleDispatchRoute(() => dispatcher);

    const response = await post(await request(body, signed));

    expect([400, 401]).toContain(response.status);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("returns a retryable server response when dispatch creation fails", async () => {
    const dispatcher = { dispatch: vi.fn().mockRejectedValue(new Error("database unavailable")) };
    const post = createSearchConsoleDispatchRoute(() => dispatcher);

    const response = await post(await request({ scheduledAt }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Search Console dispatch failed",
      code: "SEARCH_CONSOLE_DISPATCH_FAILED",
    });
  });
});
