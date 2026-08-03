import { SEARCH_CONSOLE_PROVIDER_RESPONSE_MAX_BYTES } from "../search-console/artifact";

export const SEARCH_CONSOLE_DIMENSIONS = [
  "date",
  "query",
  "page",
  "country",
  "device",
] as const;
export const SEARCH_CONSOLE_ROW_LIMIT = 25_000;
export const SEARCH_CONSOLE_DATA_STATE = "final";
export const SEARCH_CONSOLE_MAX_RESPONSE_BYTES = SEARCH_CONSOLE_PROVIDER_RESPONSE_MAX_BYTES;

export type SearchConsoleQueryRequest = {
  startDate: string;
  endDate: string;
  startRow: number;
  dimensions?: readonly string[];
  rowLimit?: number;
  dataState?: "final";
  maximumResponseBytes?: number;
};

export type SearchConsolePage = {
  rawBody: string;
  rawBytes: Uint8Array;
  value: unknown;
};

export type SearchConsoleFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type ErrorOptions = {
  retryable: boolean;
  status?: number;
  retryAfterSeconds?: number;
};

export class SearchConsoleProviderError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, options: ErrorOptions) {
    super(message);
    this.name = "SearchConsoleProviderError";
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class SearchConsoleAuthenticationError extends SearchConsoleProviderError {
  constructor(status: number, retryAfterSeconds?: number) {
    super("Search Console credentials were rejected.", {
      retryable: false,
      status,
      retryAfterSeconds,
    });
    this.name = "SearchConsoleAuthenticationError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function retryAfterFromValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.ceil(value);
  }
  if (typeof value !== "string") return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const duration = /^(\d+)s$/i.exec(value);
  if (duration) return Number(duration[1]);
  return undefined;
}

function retryAfterSeconds(headers: Headers, body: unknown): number | undefined {
  const header = headers.get("retry-after");
  if (header !== null) {
    const seconds = retryAfterFromValue(header);
    if (seconds !== undefined) return seconds;
    const timestamp = Date.parse(header);
    if (Number.isFinite(timestamp)) return Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000));
  }

  const error = asRecord(asRecord(body)?.error);
  const details = Array.isArray(error?.details) ? error.details : [];
  const candidates = [
    error?.retryAfterSeconds,
    error?.retryAfter,
    asRecord(error?.details)?.retryAfter,
    ...details.flatMap((detail) => {
      const record = asRecord(detail);
      return record === null ? [] : [record.retryDelay, record.retryAfter];
    }),
  ];
  for (const candidate of candidates) {
    const seconds = retryAfterFromValue(candidate);
    if (seconds !== undefined) return seconds;
  }
  return undefined;
}

function googleErrorReasons(body: unknown, status: number) {
  const error = asRecord(asRecord(body)?.error);
  if (
    error === null ||
    error.code !== status ||
    typeof error.message !== "string" ||
    error.message.length === 0 ||
    (error.status !== undefined && (typeof error.status !== "string" || error.status.length === 0)) ||
    (error.errors !== undefined && !Array.isArray(error.errors)) ||
    (error.details !== undefined && !Array.isArray(error.details))
  ) {
    return null;
  }
  const legacyReasons = Array.isArray(error.errors)
    ? error.errors.map((item) => asRecord(item)?.reason)
    : [];
  if (!legacyReasons.every((reason) => typeof reason === "string" && reason.length > 0)) {
    return null;
  }
  const detailReasons = Array.isArray(error.details)
    ? error.details.map((item) => asRecord(item)?.reason)
    : [];
  if (!detailReasons.every(
    (reason): reason is string => typeof reason === "string" && reason.length > 0,
  )) {
    return null;
  }
  return [
    ...(typeof error.status === "string" ? [error.status] : []),
    ...legacyReasons as string[],
    ...detailReasons,
  ];
}

function quotaReasonsOnly(reasons: readonly string[]) {
  const retryableReasons = new Set([
    "quotaexceeded",
    "ratelimitexceeded",
    "ratelimitexceededunreg",
    "userratelimitexceeded",
    "userratelimitexceededunreg",
    "servinglimitexceeded",
    "concurrentlimitexceeded",
    "limitexceeded",
    "variabletermexpireddailyexceeded",
    "variabletermlimitexceeded",
    "dailylimitexceeded",
    "dailylimitexceededunreg",
    "downloadquotaexceeded",
    "quota_exceeded",
    "rate_limit_exceeded",
    "resource_exhausted",
  ]);
  return reasons.length > 0 && reasons.every(
    (reason) => retryableReasons.has(reason.toLowerCase()),
  );
}

function parsedResponseContainsSecret(root: unknown, secret: string) {
  const pending: unknown[] = [root];
  const seen = new WeakSet<object>();
  let inspected = 0;
  const maximumInspectedValues = 1_000_000;
  while (pending.length > 0) {
    if (inspected >= maximumInspectedValues) return true;
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

function providerError(status: number, body: unknown, headers: Headers) {
  const retryAfter = retryAfterSeconds(headers, body);
  const reasons = googleErrorReasons(body, status);
  if (status === 401 || (status === 403 && (reasons === null || !quotaReasonsOnly(reasons)))) {
    return new SearchConsoleAuthenticationError(status, retryAfter);
  }
  return new SearchConsoleProviderError("Search Console request failed.", {
    status,
    retryAfterSeconds: retryAfter,
    retryable: status === 429 || status >= 500 ||
      (status === 403 && reasons !== null && quotaReasonsOnly(reasons)),
  });
}

export class SearchConsoleClient {
  private readonly token: string;
  private readonly fetch: SearchConsoleFetch;
  private readonly maximumResponseBytes: number;

  constructor(options: {
    token: string;
    fetch?: SearchConsoleFetch;
    maximumResponseBytes?: number;
  }) {
    if (
      typeof options.token !== "string" ||
      options.token.length === 0 ||
      Buffer.byteLength(options.token, "utf8") > 64 * 1024 ||
      /[\u0000-\u001f\u007f]/.test(options.token)
    ) {
      throw new SearchConsoleProviderError("Search Console credential is invalid.", {
        retryable: false,
      });
    }
    const maximumResponseBytes = options.maximumResponseBytes ?? SEARCH_CONSOLE_MAX_RESPONSE_BYTES;
    if (
      !Number.isInteger(maximumResponseBytes) ||
      maximumResponseBytes < 1 ||
      maximumResponseBytes > SEARCH_CONSOLE_MAX_RESPONSE_BYTES
    ) {
      throw new SearchConsoleProviderError("Search Console response limit is invalid.", {
        retryable: false,
      });
    }
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.maximumResponseBytes = maximumResponseBytes;
  }

  async query(property: string, request: SearchConsoleQueryRequest): Promise<SearchConsolePage> {
    const body = JSON.stringify({
      startDate: request.startDate,
      endDate: request.endDate,
      dimensions: SEARCH_CONSOLE_DIMENSIONS,
      rowLimit: SEARCH_CONSOLE_ROW_LIMIT,
      startRow: request.startRow,
      dataState: SEARCH_CONSOLE_DATA_STATE,
    });
    let response: Response;
    try {
      response = await this.fetch(
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          redirect: "error",
          body,
        },
      );
    } catch {
      throw new SearchConsoleProviderError("Search Console request could not be completed.", {
        retryable: true,
      });
    }

    let rawBody: string;
    let rawBytes: Uint8Array;
    let value: unknown;
    try {
      const requestedLimit = request.maximumResponseBytes ?? this.maximumResponseBytes;
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
        throw new SearchConsoleProviderError("Search Console response limit is invalid.", {
          status: response.status,
          retryable: false,
        });
      }
      ({ rawBody, rawBytes } = await readBoundedResponseBody(
        response,
        Math.min(this.maximumResponseBytes, requestedLimit),
      ));
      if (rawBody.includes(this.token)) {
        throw new SearchConsoleProviderError(
          "Search Console returned a response that cannot be retained safely.",
          { status: response.status, retryable: false },
        );
      }
      value = JSON.parse(rawBody);
      if (parsedResponseContainsSecret(value, this.token)) {
        throw new SearchConsoleProviderError(
          "Search Console returned a response that cannot be retained safely.",
          { status: response.status, retryable: false },
        );
      }
    } catch (error) {
      if (response.status === 401 || response.status === 403) {
        throw providerError(response.status, null, response.headers);
      }
      if (error instanceof SearchConsoleProviderError) throw error;
      throw new SearchConsoleProviderError("Search Console returned an invalid response.", {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        retryAfterSeconds: retryAfterSeconds(response.headers, null),
      });
    }
    if (!response.ok) throw providerError(response.status, value, response.headers);
    return { rawBody, rawBytes, value };
  }
}

async function readBoundedResponseBody(response: Response, maximumBytes: number) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new SearchConsoleProviderError("Search Console response exceeded the raw byte limit.", {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        retryAfterSeconds: retryAfterSeconds(response.headers, null),
      });
    }
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return { rawBody: "", rawBytes: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > maximumBytes - size) {
        throw new SearchConsoleProviderError("Search Console response exceeded the raw byte limit.", {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
          retryAfterSeconds: retryAfterSeconds(response.headers, null),
        });
      }
      chunks.push(value);
      size += value.byteLength;
    }
    complete = true;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      rawBody: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      rawBytes: bytes,
    };
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Preserve the bounded response error.
    }
  }
}
