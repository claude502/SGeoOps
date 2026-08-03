import { createHash } from "node:crypto";

export const maximumSearchConsoleControlBodyBytes = 64 * 1024;
const maximumIdentifierLength = 200;
const maximumPropertyLength = 2_048;

export type SearchConsoleControlRequestScope = {
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
  integrationId: string;
  property: string;
};

export type BoundedJsonResult =
  | { ok: true; body: unknown; digest: string }
  | { ok: false; code: "INVALID" | "TOO_LARGE"; digest?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedIdentifier(value: unknown) {
  return typeof value === "string" &&
    value.length <= maximumIdentifierLength &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)
    ? value
    : null;
}

function searchConsoleProperty(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumPropertyLength ||
    /[\u0000-\u001f\u007f\s]/.test(value)
  ) {
    return null;
  }
  if (value.startsWith("sc-domain:")) {
    const domain = value.slice("sc-domain:".length);
    return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)
      ? value
      : null;
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname === "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    return parsed.toString() === value ? value : null;
  } catch {
    return null;
  }
}

export function parseSearchConsoleControlRequestScope(
  value: unknown,
): SearchConsoleControlRequestScope | null {
  const record = asRecord(value);
  if (record === null) return null;
  const expectedKeys = [
    "brandId",
    "clientId",
    "integrationId",
    "property",
    "siteId",
    "siteMarketId",
  ];
  if (
    Object.keys(record).sort().join("\u0000") !== expectedKeys.join("\u0000") ||
    (record.siteMarketId !== null && boundedIdentifier(record.siteMarketId) === null)
  ) {
    return null;
  }
  const clientId = boundedIdentifier(record.clientId);
  const brandId = boundedIdentifier(record.brandId);
  const siteId = boundedIdentifier(record.siteId);
  const integrationId = boundedIdentifier(record.integrationId);
  const property = searchConsoleProperty(record.property);
  if (clientId === null || brandId === null || siteId === null || integrationId === null || property === null) {
    return null;
  }
  return {
    clientId,
    brandId,
    siteId,
    siteMarketId: record.siteMarketId as string | null,
    integrationId,
    property,
  };
}

export function parseSearchConsoleRunId(value: unknown) {
  return boundedIdentifier(value);
}

function declaredLength(request: Request) {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return "invalid" as const;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : "invalid" as const;
}

export async function readBoundedJsonBody(
  request: Request,
  maximumByteSize = maximumSearchConsoleControlBodyBytes,
): Promise<BoundedJsonResult> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return { ok: false, code: "INVALID" };
  const length = declaredLength(request);
  if (length === "invalid") return { ok: false, code: "INVALID" };
  if (length !== null && length > maximumByteSize) {
    await request.body?.cancel().catch(() => undefined);
    return { ok: false, code: "TOO_LARGE" };
  }
  const reader = request.body?.getReader();
  if (reader === undefined) return { ok: false, code: "INVALID" };
  const chunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return { ok: false, code: "INVALID" };
      if (value.byteLength > maximumByteSize - size) return { ok: false, code: "TOO_LARGE" };
      chunks.push(value);
      size += value.byteLength;
      hash.update(value);
    }
    complete = true;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const digest = hash.digest("hex");
    try {
      return {
        ok: true,
        body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        digest,
      };
    } catch {
      return { ok: false, code: "INVALID", digest };
    }
  } catch {
    return { ok: false, code: "INVALID" };
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // The route returns the original safe reader failure.
    }
  }
}
