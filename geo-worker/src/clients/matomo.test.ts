import { describe, expect, it, vi } from "vitest";
import { MatomoAuthenticationError, MatomoClient, MatomoProviderError } from "./matomo";

const request = { method: "Actions.getPageUrls" as const, idSite: 7, startDate: "2026-07-01", endDate: "2026-07-02", segment: "countryCode==my", timezone: "Asia/Kuala_Lumpur", metric: "nb_hits" as const };

describe("Matomo client", () => {
  it("POSTs token_auth only in the form body", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    await new MatomoClient({ endpoint: "https://analytics.example", token: "private-token", fetch }).query(request);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://analytics.example/index.php");
    expect(init.method).toBe("POST");
    expect(String(url)).not.toContain("private-token");
    expect(String(init.body)).toContain("token_auth=private-token");
    expect(String(init.body)).toContain("format_metrics=0");
    expect(String(init.body)).toContain("showMetadata=0");
    expect(String(init.body)).toContain("flat=1");
    expect(String(init.body)).toContain("filter_limit=-1");
  });

  it("rejects malformed report requests before the provider fetch", async () => {
    const fetch = vi.fn();
    const client = new MatomoClient({ endpoint: "https://analytics.example", token: "secret", fetch });
    const invalid = [
      { ...request, method: "UsersManager.getUsers" },
      { ...request, idSite: 0 },
      { ...request, idSite: 1.5 },
      { ...request, startDate: "today" },
      { ...request, endDate: "2026-06-30" },
      { ...request, segment: "x".repeat(1_025) },
      { ...request, idGoal: -1 },
    ];
    for (const value of invalid) {
      await expect(client.query(value as never)).rejects.toMatchObject({ retryable: false });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://user:pass@analytics.example",
    "https://analytics.example/path",
    "https://analytics.example?token_auth=x",
    "ftp://analytics.example",
  ])("rejects non-origin endpoint %s", (endpoint) => {
    expect(() => new MatomoClient({ endpoint, token: "secret" })).toThrow(MatomoProviderError);
  });

  it("rejects literal and escaped decoded token echoes", async () => {
    for (const body of [
      '{"echo":"private-token"}',
      '{"echo":"private\\u002dtoken"}',
      '{"private\\u002dtoken":"echo"}',
    ]) {
      const client = new MatomoClient({ endpoint: "https://analytics.example", token: "private-token", fetch: vi.fn().mockResolvedValue(new Response(body)) });
      const caught = await client.query(request).catch((error: unknown) => error);
      expect(caught).toMatchObject({ retryable: false });
      expect(String(caught)).not.toContain("private-token");
    }
  });

  it("bounds success and error bodies and classifies auth and retryable failures", async () => {
    const oversized = new MatomoClient({ endpoint: "https://analytics.example", token: "secret", maximumResponseBytes: 8, fetch: vi.fn().mockResolvedValue(new Response("123456789")) });
    await expect(oversized.query(request)).rejects.toMatchObject({ retryable: false });
    const malformed = new MatomoClient({ endpoint: "https://analytics.example", token: "secret", fetch: vi.fn().mockResolvedValue(new Response("not-json")) });
    await expect(malformed.query(request)).rejects.toBeInstanceOf(MatomoProviderError);
    const auth = new MatomoClient({ endpoint: "https://analytics.example", token: "secret", fetch: vi.fn().mockResolvedValue(new Response('{"result":"error","message":"Invalid token_auth"}', { status: 403 })) });
    await expect(auth.query(request)).rejects.toBeInstanceOf(MatomoAuthenticationError);
    const retry = new MatomoClient({ endpoint: "https://analytics.example", token: "secret", fetch: vi.fn().mockResolvedValue(new Response('{"result":"error","message":"busy"}', { status: 503 })) });
    await expect(retry.query(request)).rejects.toMatchObject({ retryable: true, status: 503 });
  });

  it.each([401, 403])("classifies unreadable and oversized %i responses as authentication failures", async (status) => {
    const oversized = new MatomoClient({
      endpoint: "https://analytics.example",
      token: "secret",
      maximumResponseBytes: 8,
      fetch: vi.fn().mockResolvedValue(new Response("{}", {
        status,
        headers: { "content-length": "9" },
      })),
    });
    await expect(oversized.query(request)).rejects.toBeInstanceOf(MatomoAuthenticationError);

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("reader failed")); },
    });
    const unreadable = new MatomoClient({
      endpoint: "https://analytics.example",
      token: "secret",
      fetch: vi.fn().mockResolvedValue(new Response(stream, { status })),
    });
    await expect(unreadable.query(request)).rejects.toBeInstanceOf(MatomoAuthenticationError);
  });

  it("fails closed for malformed Matomo API error objects", async () => {
    const client = new MatomoClient({
      endpoint: "https://analytics.example",
      token: "secret",
      fetch: vi.fn().mockResolvedValue(Response.json({ result: "error", message: 7 })),
    });
    await expect(client.query(request)).rejects.toMatchObject({
      name: "MatomoProviderError",
      retryable: false,
    });
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
  ])("classifies HTTP %i as retryable=%s without exposing response data", async (status, retryable) => {
    const token = "matomo-token-never-log";
    const client = new MatomoClient({
      endpoint: "https://analytics.example",
      token,
      fetch: vi.fn().mockResolvedValue(Response.json({ result: "error", message: "provider rejected request" }, { status })),
    });
    const caught = await client.query(request).catch((error: unknown) => error);
    expect(caught).toMatchObject({ retryable, status });
    expect(String(caught)).not.toContain(token);
    expect(String(caught)).not.toContain("provider rejected request");
  });
});
