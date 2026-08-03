import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  SEARCH_CONSOLE_DIMENSIONS,
  SEARCH_CONSOLE_MAX_RESPONSE_BYTES,
  SearchConsoleAuthenticationError,
  SearchConsoleClient,
  SearchConsoleProviderError,
} from "./search-console";

const property = "sc-domain:shop.example";
const token = "google-access-token-that-must-never-be-logged";

function fixture(name: string) {
  return readFile(new URL(`../../test/fixtures/search-console/${name}`, import.meta.url), "utf8");
}

describe("SearchConsoleClient", () => {
  it("posts the exact finalized Search Analytics query without exposing its bearer token", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(await fixture("v1-success-page-1.json"), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = new SearchConsoleClient({ token, fetch });

    const page = await client.query(property, {
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      startRow: 25_000,
    });

    expect(SEARCH_CONSOLE_DIMENSIONS).toEqual(["date", "query", "page", "country", "device"]);
    expect(SEARCH_CONSOLE_MAX_RESPONSE_BYTES * 4 + 8 + 4 * 8).toBe(64 * 1024 * 1024);
    expect(fetch).toHaveBeenCalledWith(
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Ashop.example/searchAnalytics/query",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(request.redirect).toBe("error");
    expect(request.headers).toMatchObject({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(request.body as string)).toEqual({
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      dimensions: ["date", "query", "page", "country", "device"],
      rowLimit: 25_000,
      startRow: 25_000,
      dataState: "final",
    });
    expect(page.rawBody).toContain('"responseAggregationType"');
    expect(page.rawBytes).toEqual(new TextEncoder().encode(page.rawBody));
    expect(JSON.stringify(page)).not.toContain(token);
  });

  it.each([
    ["429", "v1-rate-limited.json", 429, SearchConsoleProviderError, true],
    ["quota 403", "v1-quota-403.json", 403, SearchConsoleProviderError, true],
    ["upstream 5xx", "v1-upstream-error.json", 503, SearchConsoleProviderError, true],
    ["unauthorized 401", "v1-unauthorized.json", 401, SearchConsoleAuthenticationError, false],
    ["non-quota 403", "v1-forbidden.json", 403, SearchConsoleAuthenticationError, false],
  ])("classifies %s without echoing a bearer token", async (
    _label,
    fixtureName,
    status,
    ErrorType,
    retryable,
  ) => {
    const client = new SearchConsoleClient({
      token,
      fetch: vi.fn().mockResolvedValue(new Response(await fixture(fixtureName), {
        status,
        headers: { "retry-after": "17" },
      })),
    });

    await expect(client.query(property, {
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      startRow: 0,
    })).rejects.toMatchObject({
      name: ErrorType.name,
      retryable,
      retryAfterSeconds: 17,
    });
    await expect(client.query(property, {
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      startRow: 0,
    })).rejects.not.toThrow(token);
  });

  it("classifies an ordinary validation 400 as permanent", async () => {
    const client = new SearchConsoleClient({
      token,
      fetch: vi.fn().mockResolvedValue(Response.json({
        error: {
          code: 400,
          message: "Invalid request",
          errors: [{ reason: "invalidParameter" }],
        },
      }, { status: 400 })),
    });

    await expect(client.query(property, {
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      startRow: 0,
    })).rejects.toMatchObject({
      name: "SearchConsoleProviderError",
      status: 400,
      retryable: false,
    });
  });

  it("does not disable credentials for a structurally invalid Google 403 error", async () => {
    const client = new SearchConsoleClient({
      token,
      fetch: vi.fn().mockResolvedValue(Response.json({
        error: { code: "403", message: "", errors: [{ unexpected: true }] },
      }, { status: 403 })),
    });

    await expect(client.query(property, {
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      startRow: 0,
    })).rejects.toMatchObject({
      name: "SearchConsoleProviderError",
      retryable: false,
      status: 403,
    });
  });

  it.each(["dailyLimitExceeded", "dailyLimitExceededUnreg", "downloadQuotaExceeded"])(
    "classifies Google quota reason %s as retryable",
    async (reason) => {
      const client = new SearchConsoleClient({
        token,
        fetch: vi.fn().mockResolvedValue(Response.json({
          error: { code: 403, message: "Quota exceeded", errors: [{ reason }] },
        }, { status: 403 })),
      });

      await expect(client.query(property, {
        startDate: "2026-07-01",
        endDate: "2026-07-02",
        startRow: 0,
      })).rejects.toMatchObject({
        name: "SearchConsoleProviderError",
        retryable: true,
        status: 403,
      });
    },
  );

  it.each([
    "rateLimitExceededUnreg",
    "userRateLimitExceededUnreg",
    "servingLimitExceeded",
    "concurrentLimitExceeded",
    "limitExceeded",
    "variableTermExpiredDailyExceeded",
    "variableTermLimitExceeded",
  ])("classifies documented Google rate/quota reason %s as retryable", async (reason) => {
    const client = new SearchConsoleClient({
      token,
      fetch: vi.fn().mockResolvedValue(Response.json({
        error: { code: 403, message: "Provider limit exceeded", errors: [{ reason }] },
      }, { status: 403 })),
    });

    await expect(client.query(property, {
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      startRow: 0,
    })).rejects.toMatchObject({
      name: "SearchConsoleProviderError",
      retryable: true,
      status: 403,
    });
  });

  it("classifies modern Google RESOURCE_EXHAUSTED details as retryable quota", async () => {
    const client = new SearchConsoleClient({
      token,
      fetch: vi.fn().mockResolvedValue(Response.json({
        error: {
          code: 403,
          message: "Quota exhausted",
          status: "RESOURCE_EXHAUSTED",
          details: [{
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "RATE_LIMIT_EXCEEDED",
          }],
        },
      }, { status: 403 })),
    });

    await expect(client.query(property, {
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      startRow: 0,
    })).rejects.toMatchObject({ retryable: true, status: 403 });
  });

  it("exposes Google RetryInfo delay as bounded retry observability", async () => {
    const client = new SearchConsoleClient({
      token,
      fetch: vi.fn().mockResolvedValue(Response.json({
        error: {
          code: 429,
          message: "Rate limited",
          errors: [{ reason: "rateLimitExceeded" }],
          details: [{
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "23s",
          }],
        },
      }, { status: 429 })),
    });

    await expect(client.query(property, {
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      startRow: 0,
    })).rejects.toMatchObject({ retryable: true, retryAfterSeconds: 23 });
  });

  it("rejects oversized provider bodies before retaining them", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"rows\":["));
        controller.enqueue(new Uint8Array(128));
      },
      cancel,
    }), { status: 200 });
    const client = new SearchConsoleClient({
      token,
      fetch: vi.fn().mockResolvedValue(response),
      maximumResponseBytes: 64,
    });

    await expect(client.query(property, {
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      startRow: 0,
    })).rejects.toMatchObject({
      name: "SearchConsoleProviderError",
      retryable: false,
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects a provider response that echoes the bearer token before artifact creation", async () => {
    const client = new SearchConsoleClient({
      token,
      fetch: vi.fn().mockResolvedValue(Response.json({ rows: [], echoed: token })),
    });

    const result = client.query(property, {
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      startRow: 0,
    });
    await expect(result).rejects.toMatchObject({
      name: "SearchConsoleProviderError",
      retryable: false,
    });
    await expect(result).rejects.not.toThrow(token);
  });

  it.each([
    ["string value", '{"rows":[],"echo":"secret\\u002dtoken"}'],
    ["object key", '{"rows":[],"secret\\u002dtoken":"echo"}'],
  ])("rejects a bearer token hidden by JSON escaping in a parsed %s", async (_location, rawBody) => {
    const escapedToken = "secret-token";
    expect(rawBody).not.toContain(escapedToken);
    const client = new SearchConsoleClient({
      token: escapedToken,
      fetch: vi.fn().mockResolvedValue(new Response(rawBody, { status: 200 })),
    });

    const result = client.query(property, {
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      startRow: 0,
    });

    await expect(result).rejects.toMatchObject({
      name: "SearchConsoleProviderError",
      retryable: false,
    });
    await expect(result).rejects.not.toThrow(escapedToken);
  });
});
