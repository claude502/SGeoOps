import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface InternalSignature {
  timestamp: string;
  signature: string;
}

export type InternalRequestBody = string | Uint8Array;

const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_TIMESTAMP_LENGTH = 16;
const CANONICAL_TIMESTAMP_PATTERN = /^(0|[1-9]\d*)$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function resolveNowSeconds(nowSeconds?: number): number | null {
  const resolved = nowSeconds ?? Math.floor(Date.now() / 1_000);
  return Number.isSafeInteger(resolved) && resolved >= 0 ? resolved : null;
}

function parseCanonicalTimestamp(timestamp: string): number | null {
  if (
    timestamp.length > MAX_TIMESTAMP_LENGTH ||
    !CANONICAL_TIMESTAMP_PATTERN.test(timestamp)
  ) {
    return null;
  }

  const parsed = Number(timestamp);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function createCanonicalInput(
  timestamp: string,
  method: string,
  pathname: string,
  body: InternalRequestBody,
): string {
  const bodyHasher = createHash("sha256");
  if (typeof body === "string") {
    bodyHasher.update(body, "utf8");
  } else {
    bodyHasher.update(body);
  }
  const bodyHash = bodyHasher.digest("hex");
  return `${timestamp}\n${method}\n${pathname}\n${bodyHash}`;
}

function createSignature(
  secret: string,
  timestamp: string,
  method: string,
  pathname: string,
  body: InternalRequestBody,
): string {
  return createHmac("sha256", secret)
    .update(createCanonicalInput(timestamp, method, pathname, body), "utf8")
    .digest("hex");
}

export async function signInternalRequest(
  secret: string,
  method: string,
  pathname: string,
  body: InternalRequestBody,
  nowSeconds?: number,
): Promise<InternalSignature> {
  if (secret.length === 0) {
    throw new Error("Internal request secret must be non-empty");
  }

  const resolvedNowSeconds = resolveNowSeconds(nowSeconds);
  if (resolvedNowSeconds === null) {
    throw new Error("nowSeconds must be a non-negative integer");
  }

  const timestamp = String(resolvedNowSeconds);
  return {
    timestamp,
    signature: createSignature(secret, timestamp, method, pathname, body),
  };
}

export async function verifyInternalRequest(
  secret: string,
  signed: InternalSignature,
  method: string,
  pathname: string,
  body: InternalRequestBody,
  nowSeconds?: number,
): Promise<boolean> {
  if (
    secret.length === 0 ||
    typeof signed?.timestamp !== "string" ||
    typeof signed?.signature !== "string" ||
    !SHA256_HEX_PATTERN.test(signed.signature)
  ) {
    return false;
  }

  const resolvedNowSeconds = resolveNowSeconds(nowSeconds);
  if (resolvedNowSeconds === null) {
    return false;
  }

  const signedAt = parseCanonicalTimestamp(signed.timestamp);
  if (signedAt === null) {
    return false;
  }

  const clockSkew = Math.abs(signedAt - resolvedNowSeconds);
  if (clockSkew > MAX_CLOCK_SKEW_SECONDS) {
    return false;
  }

  const expected = Buffer.from(
    createSignature(secret, signed.timestamp, method, pathname, body),
    "hex",
  );
  const received = Buffer.from(signed.signature, "hex");
  return timingSafeEqual(expected, received);
}
