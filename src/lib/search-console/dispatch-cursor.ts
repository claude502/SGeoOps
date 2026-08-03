import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { readInternalSigningSecret } from "@/lib/internal-auth";

const cursorVersion = "v1";
const maximumCursorLength = 2_048;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

type CursorPayload = {
  afterIntegrationId: string;
  scheduledAt: string;
  version: 1;
};

function encryptionKey(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest();
}

function encode(value: Buffer) {
  return value.toString("base64url");
}

function decode(value: string) {
  if (!base64UrlPattern.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

function signedValue(secret: string, value: string) {
  return createHmac("sha256", secret).update(value, "utf8").digest();
}

function canonicalScheduledAt(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : null;
}

function parsePayload(value: unknown, scheduledAt: string): CursorPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join("\u0000") !== "afterIntegrationId\u0000scheduledAt\u0000version") return null;
  if (
    record.version !== 1 ||
    canonicalScheduledAt(record.scheduledAt) !== scheduledAt ||
    typeof record.afterIntegrationId !== "string" ||
    !identifierPattern.test(record.afterIntegrationId)
  ) {
    return null;
  }
  return {
    afterIntegrationId: record.afterIntegrationId,
    scheduledAt,
    version: 1,
  };
}

async function requiredSecret() {
  const secret = await readInternalSigningSecret();
  if (secret === null) throw new Error("Search Console dispatch cursor secret is unavailable.");
  return secret;
}

export async function createSearchConsoleDispatchCursor(
  scheduledAt: string,
  afterIntegrationId: string,
) {
  const payload = parsePayload({ afterIntegrationId, scheduledAt, version: 1 }, scheduledAt);
  if (payload === null) throw new Error("Search Console dispatch cursor payload is invalid.");
  const secret = await requiredSecret();
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), initializationVector);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const unsigned = [
    cursorVersion,
    encode(initializationVector),
    encode(encrypted),
    encode(tag),
  ].join(".");
  return `${unsigned}.${encode(signedValue(secret, unsigned))}`;
}

export async function parseSearchConsoleDispatchCursor(
  cursor: unknown,
  scheduledAt: string,
) {
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > maximumCursorLength ||
    canonicalScheduledAt(scheduledAt) === null
  ) {
    return null;
  }
  const [version, encodedVector, encodedCiphertext, encodedTag, encodedSignature, ...extra] = cursor.split(".");
  if (
    extra.length > 0 ||
    version !== cursorVersion ||
    encodedVector === undefined ||
    encodedCiphertext === undefined ||
    encodedTag === undefined ||
    encodedSignature === undefined
  ) {
    return null;
  }
  const initializationVector = decode(encodedVector);
  const ciphertext = decode(encodedCiphertext);
  const tag = decode(encodedTag);
  const signature = decode(encodedSignature);
  if (
    initializationVector === null ||
    ciphertext === null ||
    tag === null ||
    signature === null ||
    initializationVector.byteLength !== 12 ||
    tag.byteLength !== 16 ||
    signature.byteLength !== 32
  ) {
    return null;
  }
  let secret: string;
  try {
    secret = await requiredSecret();
  } catch {
    return null;
  }
  const unsigned = [version, encodedVector, encodedCiphertext, encodedTag].join(".");
  const expectedSignature = signedValue(secret, unsigned);
  if (!timingSafeEqual(expectedSignature, signature)) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), initializationVector);
    decipher.setAuthTag(tag);
    const decoded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = parsePayload(JSON.parse(decoded.toString("utf8")), scheduledAt);
    return payload?.afterIntegrationId ?? null;
  } catch {
    return null;
  }
}
