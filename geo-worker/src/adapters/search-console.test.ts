import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { SearchConsoleClient } from "../clients/search-console";
import {
  executeSearchConsole,
  parseSearchConsoleInput,
  SearchConsoleInputError,
  SEARCH_CONSOLE_MAX_ENVELOPE_BYTES,
  type SearchConsoleInput,
} from "./search-console";

const input: SearchConsoleInput = {
  runId: "run_search_console_1",
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: null,
  integrationId: "integration_1",
  property: "sc-domain:shop.example",
  startDate: "2026-07-01",
  endDate: "2026-07-02",
};

function fixture(name: string) {
  return readFile(new URL(`../../test/fixtures/search-console/${name}`, import.meta.url), "utf8");
}

function page(rawBody: string) {
  return {
    rawBody,
    rawBytes: new TextEncoder().encode(rawBody),
    value: JSON.parse(rawBody) as unknown,
  };
}

function decodeArtifact(bytes: Uint8Array) {
  const magic = new TextEncoder().encode("SGEOSC1\n");
  expect(bytes.slice(0, magic.byteLength)).toEqual(magic);
  const pages: Array<{ startRow: number; rawBytes: Uint8Array }> = [];
  let offset = magic.byteLength;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error("Truncated Search Console artifact header.");
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const startRow = view.getUint32(0, false);
    const length = view.getUint32(4, false);
    offset += 8;
    if (offset + length > bytes.byteLength) throw new Error("Truncated Search Console artifact page.");
    pages.push({ startRow, rawBytes: bytes.slice(offset, offset + length) });
    offset += length;
  }
  return pages;
}

describe("Search Console adapter", () => {
  it("paginates finalized Search Analytics data and preserves every provider page in the raw artifact", async () => {
    const first = await fixture("v1-success-page-1.json");
    const empty = await fixture("v1-empty.json");
    const query = vi.fn()
      .mockResolvedValueOnce(page(first))
      .mockResolvedValueOnce(page(empty));

    const result = await executeSearchConsole(input, { query });

    expect(query).toHaveBeenCalledWith(input.property, expect.objectContaining({
      startDate: input.startDate,
      endDate: input.endDate,
      dimensions: ["date", "query", "page", "country", "device"],
      rowLimit: 25_000,
      startRow: 0,
      dataState: "final",
    }));
    expect(query).toHaveBeenNthCalledWith(2, input.property, expect.objectContaining({
      startRow: 25_000,
    }));
    expect(result.envelope).toMatchObject({ status: "succeeded", error: null });
    expect(result.envelope.observations).toContainEqual(expect.objectContaining({
      kind: "search_console.search_analytics",
      subject: "https://shop.example/shoes",
      value: expect.objectContaining({
        clicks: 12,
        impressions: 120,
        ctr: 0.1,
        position: 3.4,
        date: "2026-07-01",
        query: "red shoes",
        country: "usa",
        device: "DESKTOP",
        dataState: "final",
        scope: "top_rows",
        pagination: expect.objectContaining({ pagesFetched: 2, truncated: false }),
      }),
    }));
    expect(result.envelope.observations).toContainEqual(expect.objectContaining({
      kind: "search_console.sync_summary",
      value: expect.objectContaining({
        startDate: input.startDate,
        endDate: input.endDate,
        property: input.property,
        scope: "top_rows",
        rowsFetched: 2,
        pagination: expect.objectContaining({ pagesFetched: 2, truncated: false }),
      }),
    }));
    const summary = result.envelope.observations.find(({ kind }) => kind === "search_console.sync_summary");
    expect(summary?.value).not.toHaveProperty("totalRows");
    expect(summary?.value).not.toHaveProperty("cardinality");
    expect(result.rawReport).not.toBeNull();
    const artifact = decodeArtifact(result.rawReport!);
    expect(artifact).toEqual([
      { startRow: 0, rawBytes: new TextEncoder().encode(first) },
      { startRow: 25_000, rawBytes: new TextEncoder().encode(empty) },
    ]);
    expect(new TextDecoder().decode(result.rawReport!)).not.toContain("google-access-token");
  });

  it("preserves the default SearchConsoleClient method binding", async () => {
    const first = await fixture("v1-success-page-2.json");
    const empty = await fixture("v1-empty.json");
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(first, { status: 200 }))
      .mockResolvedValueOnce(new Response(empty, { status: 200 }));
    const client = new SearchConsoleClient({ token: "default-path-token", fetch });

    const result = await executeSearchConsole(input, { client });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ startRow: 25_000 });
    expect(result.envelope).toMatchObject({ status: "succeeded", error: null });
  });

  it("marks a nonempty response partial when the page cap leaves no room for the terminating empty page", async () => {
    const query = vi.fn().mockResolvedValueOnce(page(await fixture("v1-success-page-2.json")));

    const result = await executeSearchConsole(input, { query, maximumProviderPages: 1 });

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.envelope).toMatchObject({
      status: "partial",
      error: { code: "SEARCH_CONSOLE_PROVIDER_TRUNCATED", retryable: false },
    });
  });

  it("uses startRow 25000 after a full provider page and marks provider-cap truncation explicitly", async () => {
    const fullPage = JSON.stringify({
      rows: Array.from({ length: 25_000 }, (_, index) => ({
        keys: ["2026-07-01", `query-${index}`, "https://shop.example/shoes", "usa", "DESKTOP"],
        clicks: 1,
        impressions: 10,
        ctr: 0.1,
        position: 3,
      })),
    });
    const query = vi.fn()
      .mockResolvedValueOnce(page(fullPage))
      .mockResolvedValueOnce(page(await fixture("v1-success-page-2.json")));

    const result = await executeSearchConsole(input, { query, maximumProviderPages: 2 });

    expect(query).toHaveBeenNthCalledWith(1, input.property, expect.objectContaining({ startRow: 0 }));
    expect(query).toHaveBeenNthCalledWith(2, input.property, expect.objectContaining({ startRow: 25_000 }));
    expect(result.envelope).toMatchObject({
      status: "partial",
      error: { code: "SEARCH_CONSOLE_PROVIDER_AND_ENVELOPE_TRUNCATED", retryable: false },
    });
    expect(result.rawReport).not.toBeNull();
    const artifact = decodeArtifact(result.rawReport!);
    expect(artifact[1]).toEqual({
      startRow: 25_000,
      rawBytes: new TextEncoder().encode(await fixture("v1-success-page-2.json")),
    });
  });

  it("returns a permanent invalid-report envelope for malformed response dimensions without discarding the provider artifact", async () => {
    const rawBody = await fixture("v1-invalid-keys.json");

    const result = await executeSearchConsole(input, { query: vi.fn().mockResolvedValue(page(rawBody)) });

    expect(result.rawReport).toBeInstanceOf(Uint8Array);
    expect(result.envelope).toMatchObject({
      status: "failed",
      error: { code: "SEARCH_CONSOLE_INVALID_REPORT", retryable: false },
    });
    expect(decodeArtifact(result.rawReport!)).toEqual([
      { startRow: 0, rawBytes: new TextEncoder().encode(rawBody) },
    ]);
  });

  it("rejects malformed or cross-tenant runtime inputs before provider fetch", async () => {
    const query = vi.fn();
    const invalid = [
      null,
      { ...input, runId: 7 },
      { ...input, integrationId: "" },
      { ...input, property: "https://operator:secret@shop.example/" },
      { ...input, property: "sc-domain:shop.example/path" },
      { ...input, startDate: "2026-07-03", endDate: "2026-07-02" },
      { ...input, unexpected: "field" },
      { ...input, clientId: "client id" },
      { ...input, runId: "../run" },
    ];
    for (const payload of invalid) {
      await expect(executeSearchConsole(payload as SearchConsoleInput, { query }))
        .rejects.toBeInstanceOf(SearchConsoleInputError);
    }
    expect(query).not.toHaveBeenCalled();
    expect(() => parseSearchConsoleInput({ ...input, clientId: null })).toThrow(SearchConsoleInputError);
  });

  it("rejects rows outside the requested Pacific date range", async () => {
    const rawBody = JSON.stringify({
      rows: [{
        keys: ["2026-07-03", "query", "https://shop.example/page", "usa", "DESKTOP"],
        clicks: 1,
        impressions: 2,
        ctr: 0.5,
        position: 1,
      }],
    });

    const result = await executeSearchConsole(input, {
      query: vi.fn().mockResolvedValue(page(rawBody)),
    });

    expect(result.envelope).toMatchObject({
      status: "failed",
      error: { code: "SEARCH_CONSOLE_INVALID_REPORT", retryable: false },
    });
  });

  it("treats delayed final data as a complete empty top-row result", async () => {
    const result = await executeSearchConsole(input, {
      query: vi.fn().mockResolvedValue(page(await fixture("v1-delayed-final.json"))),
    });

    expect(result.envelope).toMatchObject({ status: "succeeded", error: null });
    expect(result.envelope.observations).toContainEqual(expect.objectContaining({
      kind: "search_console.sync_summary",
      value: expect.objectContaining({
        scope: "top_rows",
        dataState: "final",
        rowsFetched: 0,
        pagination: expect.objectContaining({ truncated: false }),
      }),
    }));
  });

  it.each([
    ["first_incomplete_date", "fixture"],
    ["first_incomplete_hour", "inline"],
  ])("retains a final response with %s as non-final without writing observations", async (_field, source) => {
    const rawBody = source === "fixture"
      ? await fixture("v1-incomplete-final.json")
      : JSON.stringify({
          responseAggregationType: "byPage",
          metadata: { first_incomplete_hour: "2026-07-02T15:00:00-07:00" },
          rows: [],
        });
    const query = vi.fn().mockResolvedValue(page(rawBody));

    const result = await executeSearchConsole(input, { query });

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.rawReport).not.toBeNull();
    expect(decodeArtifact(result.rawReport!)).toEqual([
      { startRow: 0, rawBytes: new TextEncoder().encode(rawBody) },
    ]);
    expect(result.envelope).toMatchObject({
      status: "partial",
      observations: [],
      error: { code: "SEARCH_CONSOLE_NON_FINAL_DATA", retryable: false },
    });
  });

  it("rejects an unknown response aggregation type while retaining the raw response", async () => {
    const rawBody = JSON.stringify({ responseAggregationType: "futureAggregation", rows: [] });

    const result = await executeSearchConsole(input, {
      query: vi.fn().mockResolvedValue(page(rawBody)),
    });

    expect(result.rawReport).not.toBeNull();
    expect(result.envelope).toMatchObject({
      status: "failed",
      observations: [],
      error: { code: "SEARCH_CONSOLE_INVALID_REPORT", retryable: false },
    });
  });

  it.each(["byProperty", "byNewsShowcasePanel"])(
    "rejects page rows aggregated %s while retaining the raw response",
    async (responseAggregationType) => {
      const rawBody = JSON.stringify({ responseAggregationType, rows: [] });

      const result = await executeSearchConsole(input, {
        query: vi.fn().mockResolvedValue(page(rawBody)),
      });

      expect(decodeArtifact(result.rawReport!)).toEqual([
        { startRow: 0, rawBytes: new TextEncoder().encode(rawBody) },
      ]);
      expect(result.envelope).toMatchObject({
        status: "failed",
        observations: [],
        error: { code: "SEARCH_CONSOLE_INVALID_REPORT", retryable: false },
      });
    },
  );

  it("projects a compact envelope under the ingest contract cap instead of silently claiming every top row", async () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      keys: ["2026-07-01", `query-${index}`, "https://shop.example/shoes", "usa", "MOBILE"],
      clicks: 1,
      impressions: 1,
      ctr: 1,
      position: 1,
    }));
    const query = vi.fn()
      .mockResolvedValueOnce(page(JSON.stringify({ rows })))
      .mockResolvedValueOnce(page(await fixture("v1-empty.json")));
    const result = await executeSearchConsole(input, {
      query,
      maximumEnvelopeBytes: 10_000,
    });

    expect(result.envelope).toMatchObject({
      status: "partial",
      error: { code: "SEARCH_CONSOLE_ENVELOPE_TRUNCATED", retryable: false },
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(Buffer.byteLength(JSON.stringify(result.envelope))).toBeLessThanOrEqual(10_000);
    expect(SEARCH_CONSOLE_MAX_ENVELOPE_BYTES).toBe(1_024 * 1_024);
  });

  it("retains a 924-byte accepted response inside a 1024-byte artifact budget without Base64 expansion", async () => {
    const prefix = '{"rows":[],"padding":"';
    const suffix = '"}';
    const rawBody = `${prefix}${"x".repeat(924 - prefix.length - suffix.length)}${suffix}`;
    expect(Buffer.byteLength(rawBody, "utf8")).toBe(924);

    const result = await executeSearchConsole(input, {
      query: vi.fn().mockResolvedValue(page(rawBody)),
      maximumProviderPages: 1,
      maximumRawBytes: 1_024,
    });

    expect(result.envelope).toMatchObject({ status: "succeeded", error: null });
    expect(result.rawReport).not.toBeNull();
    expect(result.rawReport!.byteLength).toBeLessThanOrEqual(1_024);
    expect(decodeArtifact(result.rawReport!)).toEqual([
      { startRow: 0, rawBytes: new TextEncoder().encode(rawBody) },
    ]);
  });

  it("rejects execution limits outside their hard integer bounds before provider fetch", async () => {
    const query = vi.fn();
    for (const limits of [
      { maximumProviderPages: 0 },
      { maximumProviderPages: 5 },
      { maximumRows: 0 },
      { maximumRows: 100_001 },
      { maximumRawBytes: 0 },
      { maximumRawBytes: 64 * 1024 * 1024 + 1 },
      { maximumEnvelopeBytes: 1_024 * 1_024 + 1 },
      { maximumProviderPages: 1.5 },
    ]) {
      await expect(executeSearchConsole(input, { query, ...limits }))
        .rejects.toBeInstanceOf(SearchConsoleInputError);
    }
    expect(query).not.toHaveBeenCalled();
  });
});
