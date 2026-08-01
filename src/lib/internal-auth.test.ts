import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signInternalRequest } from "@sgeo/internal-protocol";
import { prepareSignedInternalRequest } from "./internal-auth";

const secret = "prepared-internal-auth-test-secret";
const pathname = "/api/internal/analysis-runs/run_1/artifacts";
const body = new TextEncoder().encode("artifact body");
const originalSecret = process.env.SGEO_INTERNAL_SECRET;

async function requestFor(
  timestamp = Math.floor(Date.now() / 1_000),
  signature?: string,
) {
  const signed = await signInternalRequest(secret, "POST", pathname, body, timestamp);
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      "x-sgeo-timestamp": signed.timestamp,
      "x-sgeo-signature": signature ?? signed.signature,
    },
  });
}

beforeEach(() => {
  process.env.SGEO_INTERNAL_SECRET = secret;
});

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.SGEO_INTERNAL_SECRET;
  } else {
    process.env.SGEO_INTERNAL_SECRET = originalSecret;
  }
});

describe("prepareSignedInternalRequest", () => {
  it("rejects missing, malformed, and expired headers before a body is read", async () => {
    await expect(prepareSignedInternalRequest(new Request(`http://localhost${pathname}`, {
      method: "POST",
    }))).resolves.toBeNull();
    await expect(prepareSignedInternalRequest(await requestFor(
      Math.floor(Date.now() / 1_000) - 301,
    ))).resolves.toBeNull();
    await expect(prepareSignedInternalRequest(await requestFor(
      Math.floor(Date.now() / 1_000),
      "not-a-signature",
    ))).resolves.toBeNull();
  });

  it("verifies a streaming body digest against the original method and pathname", async () => {
    const prepared = await prepareSignedInternalRequest(await requestFor());
    const digest = createHash("sha256").update(body).digest("hex");

    expect(prepared).not.toBeNull();
    await expect(prepared!.verifyBodyDigest(digest)).resolves.toBe(true);
    await expect(prepared!.verifyBodyDigest("b".repeat(64))).resolves.toBe(false);
  });
});
