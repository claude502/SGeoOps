export const MATOMO_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MATOMO_MAX_IDENTIFIER = 2_147_483_647;
const MATOMO_MAX_SEGMENT_BYTES = 1_024;
const MATOMO_MAX_DATE_RANGE_DAYS = 366;

export type MatomoReportRequest = {
  method: "Actions.getPageUrls" | "Goals.get";
  idSite: number;
  startDate: string;
  endDate: string;
  segment: string;
  timezone: string;
  metric?: "nb_hits" | "nb_visits";
  idGoal?: number;
  maximumResponseBytes?: number;
};

export type MatomoPage = {
  rawBody: string;
  rawBytes: Uint8Array;
  value: unknown;
};

export type MatomoFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type MatomoErrorOptions = {
  retryable: boolean;
  status?: number;
  retryAfterSeconds?: number;
};

export class MatomoProviderError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, options: MatomoErrorOptions) {
    super(message);
    this.name = "MatomoProviderError";
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class MatomoAuthenticationError extends MatomoProviderError {
  constructor(status?: number, retryAfterSeconds?: number) {
    super("Matomo credentials were rejected.", {
      retryable: false,
      status,
      retryAfterSeconds,
    });
    this.name = "MatomoAuthenticationError";
  }
}

function providerError(
  message: string,
  status: number | undefined,
  headers?: Headers,
): MatomoProviderError {
  return new MatomoProviderError(message, {
    retryable: status === 429 || (status !== undefined && status >= 500),
    status,
    retryAfterSeconds: headers === undefined ? undefined : retryAfterSeconds(headers),
  });
}

function validatedOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw providerError("Matomo endpoint is invalid.", undefined);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw providerError("Matomo endpoint is invalid.", undefined);
  }
  return url.origin;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? parsed
    : null;
}

function validTimezone(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function validateRequest(value: MatomoReportRequest) {
  const record = asRecord(value);
  if (record === null) throw providerError("Matomo report request is invalid.", undefined);
  const expected = [
    "endDate",
    "idSite",
    "method",
    "segment",
    "startDate",
    "timezone",
    ...(record.metric === undefined ? [] : ["metric"]),
    ...(record.idGoal === undefined ? [] : ["idGoal"]),
    ...(record.maximumResponseBytes === undefined ? [] : ["maximumResponseBytes"]),
  ].sort();
  if (Object.keys(record).sort().join("\u0000") !== expected.join("\u0000")) {
    throw providerError("Matomo report request is invalid.", undefined);
  }
  const start = date(record.startDate);
  const end = date(record.endDate);
  const dayCount = start === null || end === null
    ? Number.POSITIVE_INFINITY
    : (end.getTime() - start.getTime()) / 86_400_000 + 1;
  if (
    start === null ||
    end === null ||
    dayCount < 1 ||
    dayCount > MATOMO_MAX_DATE_RANGE_DAYS ||
    !Number.isSafeInteger(record.idSite) ||
    (record.idSite as number) < 1 ||
    (record.idSite as number) > MATOMO_MAX_IDENTIFIER ||
    !validTimezone(record.timezone) ||
    typeof record.segment !== "string" ||
    Buffer.byteLength(record.segment, "utf8") > MATOMO_MAX_SEGMENT_BYTES ||
    /[\u0000-\u001f\u007f]/.test(record.segment) ||
    /token_auth/i.test(record.segment)
  ) {
    throw providerError("Matomo report request is invalid.", undefined);
  }
  if (
    record.method === "Actions.getPageUrls" &&
    (record.metric === "nb_hits" || record.metric === "nb_visits") &&
    record.idGoal === undefined
  ) {
    return value;
  }
  if (
    record.method === "Goals.get" &&
    Number.isSafeInteger(record.idGoal) &&
    (record.idGoal as number) >= 1 &&
    (record.idGoal as number) <= MATOMO_MAX_IDENTIFIER &&
    record.metric === undefined
  ) {
    return value;
  }
  throw providerError("Matomo report request is invalid.", undefined);
}

function parsedResponseContainsSecret(root: unknown, secret: string) {
  const pending: unknown[] = [root];
  const seen = new WeakSet<object>();
  let inspected = 0;
  while (pending.length > 0) {
    if (inspected >= 1_000_000) return true;
    inspected += 1;
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.includes(secret)) return true;
      continue;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (key.includes(secret)) return true;
      pending.push((value as Record<string, unknown>)[key]);
    }
  }
  return false;
}

function retryAfterSeconds(headers: Headers) {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000))
    : undefined;
}

type MatomoApiError = { message: string } | null | "malformed";

function apiError(value: unknown): MatomoApiError {
  const body = asRecord(value);
  if (body === null || !Object.hasOwn(body, "result")) return null;
  if (
    body.result !== "error" ||
    typeof body.message !== "string" ||
    body.message.length === 0 ||
    body.message.length > 4_096 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.message)
  ) {
    return "malformed";
  }
  const keys = Object.keys(body).sort();
  if (keys.join("\u0000") !== "message\u0000result") return "malformed";
  return { message: body.message };
}

function isAuthenticationMessage(message: string) {
  return /(?:token_auth|authentication|authorization|access denied|not authorized|invalid token|requires? .{0,80} access|not allowed)/i
    .test(message);
}

async function readBoundedResponseBody(response: Response, maximumBytes: number) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw providerError("Matomo response exceeded the size limit.", response.status);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw providerError("Matomo returned an invalid response.", response.status);
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > maximumBytes - byteLength) {
        throw providerError("Matomo response exceeded the size limit.", response.status);
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
    complete = true;
    const rawBytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      rawBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      rawBytes,
      rawBody: new TextDecoder("utf-8", { fatal: true }).decode(rawBytes),
    };
  } catch (error) {
    if (error instanceof MatomoProviderError) throw error;
    throw providerError("Matomo returned an invalid response.", response.status);
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Preserve the bounded response error.
    }
  }
}

export class MatomoClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetch: MatomoFetch;
  private readonly maximumResponseBytes: number;

  constructor(options: {
    endpoint: string;
    token: string;
    fetch?: MatomoFetch;
    maximumResponseBytes?: number;
  }) {
    this.endpoint = validatedOrigin(options.endpoint);
    if (
      typeof options.token !== "string" ||
      options.token.length === 0 ||
      Buffer.byteLength(options.token, "utf8") > 64 * 1024 ||
      /[\u0000-\u001f\u007f]/.test(options.token)
    ) {
      throw providerError("Matomo credential is invalid.", undefined);
    }
    const maximumResponseBytes = options.maximumResponseBytes ?? MATOMO_MAX_RESPONSE_BYTES;
    if (
      !Number.isInteger(maximumResponseBytes) ||
      maximumResponseBytes < 1 ||
      maximumResponseBytes > MATOMO_MAX_RESPONSE_BYTES
    ) {
      throw providerError("Matomo response limit is invalid.", undefined);
    }
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.maximumResponseBytes = maximumResponseBytes;
  }

  async query(rawRequest: MatomoReportRequest): Promise<MatomoPage> {
    const request = validateRequest(rawRequest);
    const requestedLimit = request.maximumResponseBytes ?? this.maximumResponseBytes;
    if (
      !Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > this.maximumResponseBytes
    ) {
      throw providerError("Matomo response limit is invalid.", undefined);
    }
    const form = new URLSearchParams({
      module: "API",
      method: request.method,
      idSite: String(request.idSite),
      period: "range",
      date: `${request.startDate},${request.endDate}`,
      format: "JSON",
      format_metrics: "0",
      showMetadata: "0",
      filter_limit: "-1",
      segment: request.segment,
      token_auth: this.token,
    });
    if (request.method === "Actions.getPageUrls") {
      form.set("flat", "1");
      form.set("showColumns", request.metric!);
    } else {
      form.set("idGoal", String(request.idGoal));
    }

    let response: Response;
    try {
      response = await this.fetch(`${this.endpoint}/index.php`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: form.toString(),
        redirect: "error",
      });
    } catch {
      throw new MatomoProviderError("Matomo request could not be completed.", {
        retryable: true,
      });
    }

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new MatomoAuthenticationError(
        response.status,
        retryAfterSeconds(response.headers),
      );
    }

    let bounded: { rawBody: string; rawBytes: Uint8Array };
    try {
      bounded = await readBoundedResponseBody(response, requestedLimit);
    } catch {
      throw providerError(
        "Matomo returned an invalid response.",
        response.status,
        response.headers,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(bounded.rawBody);
    } catch {
      throw providerError(
        "Matomo returned an invalid response.",
        response.status,
        response.headers,
      );
    }
    if (parsedResponseContainsSecret(value, this.token)) {
      throw providerError(
        "Matomo returned a response that cannot be retained safely.",
        response.status,
      );
    }
    const error = apiError(value);
    if (error === "malformed") {
      throw providerError("Matomo returned an invalid response.", response.status);
    }
    if (error !== null && isAuthenticationMessage(error.message)) {
      throw new MatomoAuthenticationError(
        response.status || undefined,
        retryAfterSeconds(response.headers),
      );
    }
    if (!response.ok || error !== null) {
      throw providerError(
        "Matomo reporting request failed.",
        response.status,
        response.headers,
      );
    }
    return { ...bounded, value };
  }
}
