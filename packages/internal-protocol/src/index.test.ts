import { describe, expect, it } from "vitest";
import {
  signInternalRequest,
  verifyInternalRequest,
  type InternalSignature,
} from "./index";

const SECRET = "internal-service-secret";
const METHOD = "POST";
const PATHNAME = "/ingest";
const BODY = "{\"status\":\"ready\"}";
const SIGNED_AT = 1_785_438_000;

async function sign(
  overrides: {
    secret?: string;
    method?: string;
    pathname?: string;
    body?: string;
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
    body?: string;
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
