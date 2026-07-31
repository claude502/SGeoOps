import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  signInternalRequest,
  verifyInternalRequest,
  type InternalRequestBody,
  type InternalSignature,
} from "./index";

const SECRET = "internal-service-secret";
const METHOD = "POST";
const PATHNAME = "/ingest";
const BODY = "{\"status\":\"ready\"}";
const SIGNED_AT = 1_785_438_000;

function createHmacPoisonSecret(): string {
  return {
    length: 1,
    [Symbol.toPrimitive]() {
      throw new Error("HMAC must not run for an invalid timestamp");
    },
  } as unknown as string;
}

async function sign(
  overrides: {
    secret?: string;
    method?: string;
    pathname?: string;
    body?: InternalRequestBody;
    nowSeconds?: number;
  } = {},
): Promise<InternalSignature> {
  return signInternalRequest(
    overrides.secret ?? SECRET,
    overrides.method ?? METHOD,
    overrides.pathname ?? PATHNAME,
    overrides.body ?? BODY,
    overrides.nowSeconds ?? SIGNED_AT,
  );
}

async function verify(
  signed: InternalSignature,
  overrides: {
    secret?: string;
    method?: string;
    pathname?: string;
    body?: InternalRequestBody;
    nowSeconds?: number;
  } = {},
): Promise<boolean> {
  return verifyInternalRequest(
    overrides.secret ?? SECRET,
    signed,
    overrides.method ?? METHOD,
    overrides.pathname ?? PATHNAME,
    overrides.body ?? BODY,
    overrides.nowSeconds ?? SIGNED_AT,
  );
}

describe("internal request signatures", () => {
  it("exposes the backward-compatible request body contract", () => {
    expectTypeOf<InternalRequestBody>().toEqualTypeOf<string | Uint8Array>();
    expectTypeOf(signInternalRequest).parameter(3)
      .toEqualTypeOf<InternalRequestBody>();
    expectTypeOf(verifyInternalRequest).parameter(4)
      .toEqualTypeOf<InternalRequestBody>();
  });

  it("accepts a matching signature inside the permitted window", async () => {
    const signed = await sign();

    expect(await verify(signed, { nowSeconds: SIGNED_AT + 30 })).toBe(true);
  });

  it.each([
    ["past", SIGNED_AT + 300],
    ["future", SIGNED_AT - 300],
  ])("accepts a signature at the 300-second %s boundary", async (_direction, nowSeconds) => {
    const signed = await sign();

    expect(await verify(signed, { nowSeconds })).toBe(true);
  });

  it("rejects a signature that is 301 seconds old", async () => {
    const signed = await sign();

    expect(await verify(signed, { nowSeconds: SIGNED_AT + 301 })).toBe(false);
  });

  it("rejects a signature more than 300 seconds in the future", async () => {
    const signed = await sign();

    expect(await verify(signed, { nowSeconds: SIGNED_AT - 301 })).toBe(false);
  });

  it.each([
    ["fractional", "1785438000.5"],
    ["negative", "-1785438000"],
    ["NaN", "NaN"],
    ["leading-zero", "01785438000"],
    ["exponent", "1e9"],
    ["empty", ""],
  ])("rejects a %s timestamp", async (_kind, timestamp) => {
    const signed = await sign();

    expect(await verify({ ...signed, timestamp })).toBe(false);
  });

  it("accepts Number.MAX_SAFE_INTEGER and applies the clock window", async () => {
    const signed = await sign({ nowSeconds: Number.MAX_SAFE_INTEGER });

    expect(await verify(signed, {
      nowSeconds: Number.MAX_SAFE_INTEGER,
    })).toBe(true);
    expect(await verify(signed, {
      nowSeconds: Number.MAX_SAFE_INTEGER - 300,
    })).toBe(true);
    expect(await verify(signed, {
      nowSeconds: Number.MAX_SAFE_INTEGER - 301,
    })).toBe(false);
  });

  it("rejects Number.MAX_SAFE_INTEGER + 1 before HMAC", async () => {
    const signed = await sign({ nowSeconds: Number.MAX_SAFE_INTEGER });

    await expect(verifyInternalRequest(
      createHmacPoisonSecret(),
      {
        ...signed,
        timestamp: String(Number.MAX_SAFE_INTEGER + 1),
      },
      METHOD,
      PATHNAME,
      BODY,
      Number.MAX_SAFE_INTEGER,
    )).resolves.toBe(false);
  });

  it.each([
    ["thousands", "9".repeat(4_096)],
    ["one million", "9".repeat(1_000_000)],
  ])("rejects %s of timestamp digits before BigInt or HMAC", async (_size, timestamp) => {
    const signed = await sign();
    const bigIntSpy = vi.spyOn(globalThis, "BigInt").mockImplementation(() => {
      throw new Error("BigInt must not parse an oversized timestamp");
    });

    try {
      await expect(verifyInternalRequest(
        createHmacPoisonSecret(),
        { ...signed, timestamp },
        METHOD,
        PATHNAME,
        BODY,
        SIGNED_AT,
      )).resolves.toBe(false);
      expect(bigIntSpy).not.toHaveBeenCalled();
    } finally {
      bigIntSpy.mockRestore();
    }
  });

  it.each([
    ["fractional", SIGNED_AT + 0.5],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("rejects a %s signing time", async (_kind, nowSeconds) => {
    await expect(sign({ nowSeconds })).rejects.toThrow("non-negative integer");
  });

  it("rejects an invalid verification clock", async () => {
    const signed = await sign();

    await expect(verify(signed, { nowSeconds: Number.NaN })).resolves.toBe(false);
  });

  it("rejects the wrong secret", async () => {
    const signed = await sign();

    expect(await verify(signed, { secret: "different-secret" })).toBe(false);
  });

  it("rejects empty signing and verification secrets without logging them", async () => {
    await expect(sign({ secret: "" })).rejects.toThrow("non-empty");

    const signed = await sign();
    await expect(verify(signed, { secret: "" })).resolves.toBe(false);
  });

  it.each([
    ["method", { method: "PUT" }],
    ["pathname", { pathname: "/other" }],
    ["body", { body: "{\"status\":\"changed\"}" }],
  ])("rejects a changed %s", async (_field, overrides) => {
    const signed = await sign();

    expect(await verify(signed, overrides)).toBe(false);
  });

  it("treats the body as exact UTF-8 bytes", async () => {
    const signed = await sign({ body: "caf\u00e9" });

    expect(await verify(signed, { body: "cafe\u0301" })).toBe(false);
  });

  it("matches a UTF-8 string with the same explicit bytes", async () => {
    const signed = await sign({ body: "\u00e9" });

    expect(await verify(signed, {
      body: Uint8Array.of(0xc3, 0xa9),
    })).toBe(true);
  });

  it("signs a non-UTF-8 Uint8Array view using only its exact byte slice", async () => {
    const backing = Uint8Array.of(0x11, 0x00, 0x80, 0xff, 0x22);
    const body = backing.subarray(1, 4);
    const signed = await signInternalRequest(
      "secret",
      "POST",
      "/ingest",
      body,
      SIGNED_AT,
    );

    expect(signed).toEqual({
      timestamp: String(SIGNED_AT),
      signature: "a3ac8946b1ae9b46f902fb3b65bddcf102cc9464b9985a59110db80b0c09d1b1",
    });
    expect(await verifyInternalRequest(
      "secret",
      signed,
      "POST",
      "/ingest",
      body,
      SIGNED_AT,
    )).toBe(true);
    expect(await verifyInternalRequest(
      "secret",
      signed,
      "POST",
      "/ingest",
      backing,
      SIGNED_AT,
    )).toBe(false);
  });

  it("does not equate different byte encodings of the same visible character", async () => {
    const utf8 = Uint8Array.of(0xc3, 0xa9);
    const latin1 = Uint8Array.of(0xe9);
    const utf8Signed = await sign({ body: utf8 });
    const latin1Signed = await sign({ body: latin1 });

    expect(utf8Signed.signature).not.toBe(latin1Signed.signature);
    expect(await verify(utf8Signed, { body: latin1 })).toBe(false);
    expect(await verify(latin1Signed, { body: utf8 })).toBe(false);
  });

  it("hashes Uint8Array contents at each call", async () => {
    const body = Uint8Array.of(0x00, 0x80, 0xff);
    const beforeMutation = await sign({ body });

    body[1] = 0x81;
    const afterMutation = await sign({ body });

    expect(afterMutation.signature).not.toBe(beforeMutation.signature);
    expect(await verify(beforeMutation, { body })).toBe(false);
    expect(await verify(afterMutation, { body })).toBe(true);
  });

  it.each([
    ["method case", { method: "post" }],
    ["pathname case", { pathname: "/Ingest" }],
    ["pathname encoding", { pathname: "/%69ngest" }],
    ["pathname trailing slash", { pathname: "/ingest/" }],
  ])("does not normalize %s", async (_behavior, overrides) => {
    const signed = await sign();

    expect(await verify(signed, overrides)).toBe(false);
  });

  it.each([
    ["too short", "ab"],
    ["too long", "ab".repeat(33)],
    ["non-hex", "g".repeat(64)],
    ["uppercase", "A".repeat(64)],
    ["empty", ""],
  ])("returns false for a %s signature without throwing", async (_kind, signature) => {
    const signed = await sign();

    await expect(verify({ ...signed, signature })).resolves.toBe(false);
  });

  it("uses the approved canonical input exactly", async () => {
    await expect(sign({
      secret: "secret",
      method: "POST",
      pathname: "/ingest",
      body: "{}",
      nowSeconds: SIGNED_AT,
    })).resolves.toEqual({
      timestamp: String(SIGNED_AT),
      signature: "f62a99fe29aa750cfb106a618cf988d6ea948cf5c897db1bcdc6bd7eddd3ca57",
    });
  });
});
