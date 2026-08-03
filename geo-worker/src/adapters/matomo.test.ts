import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  executeMatomo,
  MATOMO_ARTIFACT_MEDIA_TYPE,
  MATOMO_ARTIFACT_NAME,
  MATOMO_MAX_RAW_BYTES,
  MatomoInputError,
  parseMatomoInput,
  type MatomoInput,
} from "./matomo";

const input: MatomoInput = {
  runId: "run_matomo_1",
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: "market_1",
  integrationId: "integration_1",
  endpoint: "https://analytics.example",
  startDate: "2026-07-01",
  endDate: "2026-07-02",
  idSite: 7,
  segment: "countryCode==my",
  timezone: "Asia/Kuala_Lumpur",
  idGoal: 1,
  goalName: "lead",
};

async function report(name: string) {
  const rawBody = await readFile(
    new URL(`../../test/fixtures/matomo/${name}`, import.meta.url),
    "utf8",
  );
  return {
    rawBody,
    rawBytes: new TextEncoder().encode(rawBody),
    value: JSON.parse(rawBody) as unknown,
  };
}

describe("Matomo adapter", () => {
  it("normalizes only page views, organic visits by page, and goal conversions while preserving report scope", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(await report("page-views.json"))
      .mockResolvedValueOnce(await report("organic-visits.json"))
      .mockResolvedValueOnce(await report("goal-conversions.json"));

    const result = await executeMatomo(input, { query });

    expect(query.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ method: "Actions.getPageUrls", metric: "nb_hits" }),
      expect.objectContaining({
        method: "Actions.getPageUrls",
        metric: "nb_visits",
        segment: "countryCode==my;referrerType==search",
      }),
      expect.objectContaining({ method: "Goals.get", idGoal: 1 }),
    ]);
    expect(result.envelope.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "page_view",
        subject: "/pricing",
        value: expect.objectContaining({
          count: 120,
          startDate: "2026-07-01",
          endDate: "2026-07-02",
          idSite: 7,
          segment: "countryCode==my",
          configuredSegment: "countryCode==my",
          timezone: "Asia/Kuala_Lumpur",
          reportMethod: "Actions.getPageUrls",
          metric: "nb_hits",
        }),
      }),
      expect.objectContaining({
        kind: "organic_visit",
        subject: "/pricing",
        value: expect.objectContaining({
          count: 60,
          segment: "countryCode==my;referrerType==search",
          configuredSegment: "countryCode==my",
          reportMethod: "Actions.getPageUrls",
          metric: "nb_visits",
        }),
      }),
      expect.objectContaining({
        kind: "matomo.sync_summary",
        value: expect.objectContaining({
          segment: "countryCode==my",
          organicSegment: "countryCode==my;referrerType==search",
        }),
      }),
      expect.objectContaining({
        kind: "conversion",
        subject: "lead",
        value: expect.objectContaining({
          count: 5,
          idGoal: 1,
          segment: "countryCode==my",
          reportMethod: "Goals.get",
        }),
      }),
    ]));
    expect(result.rawReport).toBeInstanceOf(Uint8Array);
    expect(MATOMO_ARTIFACT_NAME).toBe("matomo-reports-v1.bin");
    expect(MATOMO_ARTIFACT_MEDIA_TYPE).toBe("application/vnd.sgeo.matomo-reports.v1");
    expect(new TextDecoder().decode(result.rawReport.subarray(0, 23)))
      .toBe("SGEO-MATOMO-REPORTS-V1\n");
  });

  it("rejects credential material, malformed ownership, invalid origins, segments, timezones, and ranges before querying", async () => {
    const query = vi.fn();
    const invalid = [
      { ...input, token_auth: "secret" },
      { ...input, runId: "../run" },
      { ...input, integrationId: "" },
      { ...input, endpoint: "https://user:secret@analytics.example" },
      { ...input, endpoint: "https://analytics.example/index.php" },
      { ...input, endpoint: "https://analytics.example?token_auth=secret" },
      { ...input, idSite: 0 },
      { ...input, idSite: 1.5 },
      { ...input, idSite: 2_147_483_648 },
      { ...input, idGoal: 2_147_483_648 },
      { ...input, goalName: "" },
      { ...input, goalName: "lead\nadmin" },
      { ...input, segment: "token_auth==secret" },
      { ...input, segment: "countryCode==my\n" },
      { ...input, timezone: "Not/A_Real_Zone" },
      { ...input, startDate: "2026-07-03", endDate: "2026-07-02" },
      { ...input, startDate: "2025-01-01", endDate: "2026-01-02" },
    ];
    for (const payload of invalid) {
      await expect(executeMatomo(payload as MatomoInput, { query }))
        .rejects.toBeInstanceOf(MatomoInputError);
    }
    expect(query).not.toHaveBeenCalled();
    expect(() => parseMatomoInput({ ...input, clientId: null })).toThrow(MatomoInputError);
    expect(parseMatomoInput({ ...input, endpoint: "https://analytics.example/" }).endpoint)
      .toBe("https://analytics.example");
  });

  it("treats empty reports as a successful sync with zero business observations and a typed window summary", async () => {
    const emptyArray = "[]";
    const emptyObject = "{}";
    const query = vi.fn()
      .mockResolvedValueOnce({ rawBody: emptyArray, rawBytes: new TextEncoder().encode(emptyArray), value: [] })
      .mockResolvedValueOnce({ rawBody: emptyArray, rawBytes: new TextEncoder().encode(emptyArray), value: [] })
      .mockResolvedValueOnce({ rawBody: emptyObject, rawBytes: new TextEncoder().encode(emptyObject), value: {} });

    await expect(executeMatomo(input, { query })).resolves.toMatchObject({
      envelope: {
        status: "succeeded",
        observations: [expect.objectContaining({
          kind: "matomo.sync_summary",
          subject: "matomo",
          value: expect.objectContaining({
            startDate: input.startDate,
            endDate: input.endDate,
            idSite: input.idSite,
            idGoal: input.idGoal,
            segment: input.segment,
            organicSegment: `${input.segment};referrerType==search`,
            timezone: input.timezone,
          }),
        })],
        error: null,
      },
    });
  });

  it("rejects arbitrary external URLs instead of turning them into local page subjects", async () => {
    const external = JSON.stringify([{ label: "https://external.example/pricing", nb_hits: 1 }]);
    const query = vi.fn()
      .mockResolvedValueOnce({ rawBody: external, rawBytes: new TextEncoder().encode(external), value: JSON.parse(external) })
      .mockResolvedValueOnce(await report("organic-visits.json"))
      .mockResolvedValueOnce(await report("goal-conversions.json"));

    await expect(executeMatomo(input, { query })).resolves.toMatchObject({
      envelope: { status: "failed", observations: [] },
    });
  });

  it("canonicalizes and aggregates safe local page paths", async () => {
    const raw = JSON.stringify([
      { label: "/pricing?campaign=a", nb_hits: 70 },
      { label: "/pricing#plans", nb_hits: 50 },
    ]);
    const query = vi.fn()
      .mockResolvedValueOnce({ rawBody: raw, rawBytes: new TextEncoder().encode(raw), value: JSON.parse(raw) })
      .mockResolvedValueOnce(await report("organic-visits.json"))
      .mockResolvedValueOnce(await report("goal-conversions.json"));

    const result = await executeMatomo(input, { query });
    expect(result.envelope.observations.filter((item) => item.kind === "page_view"))
      .toEqual([expect.objectContaining({ subject: "/pricing", value: expect.objectContaining({ count: 120 }) })]);
  });

  it("returns a failed envelope while retaining bounded raw evidence for malformed reports", async () => {
    const malformed = JSON.stringify([{ label: "https://user:secret@example.com/pricing", nb_hits: 1 }]);
    const query = vi.fn()
      .mockResolvedValueOnce({ rawBody: malformed, rawBytes: new TextEncoder().encode(malformed), value: JSON.parse(malformed) })
      .mockResolvedValueOnce(await report("organic-visits.json"))
      .mockResolvedValueOnce(await report("goal-conversions.json"));

    const result = await executeMatomo(input, { query });

    expect(result.rawReport).toBeInstanceOf(Uint8Array);
    expect(result.envelope).toMatchObject({
      status: "failed",
      observations: [],
      error: { code: "MATOMO_INVALID_REPORT", retryable: false },
    });
  });

  it("rejects inconsistent raw bytes and aggregate artifacts over the fixed cap", async () => {
    const page = await report("page-views.json");
    const invalidRaw = { ...page, rawBytes: new TextEncoder().encode("different") };
    await expect(executeMatomo(input, { query: vi.fn().mockResolvedValue(invalidRaw) }))
      .rejects.toMatchObject({ name: "MatomoExecutionError", retryable: false });

    const query = vi.fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(await report("organic-visits.json"))
      .mockResolvedValueOnce(await report("goal-conversions.json"));
    await expect(executeMatomo(input, { query, maximumRawBytes: 16 }))
      .rejects.toMatchObject({ name: "MatomoExecutionError", retryable: false });
    expect(MATOMO_MAX_RAW_BYTES).toBe(4 * 1024 * 1024);
  });

  it("builds a deterministic framed artifact from the exact provider bytes", async () => {
    const pages = [
      await report("page-views.json"),
      await report("organic-visits.json"),
      await report("goal-conversions.json"),
    ];
    const first = await executeMatomo(input, { query: vi.fn()
      .mockResolvedValueOnce(pages[0])
      .mockResolvedValueOnce(pages[1])
      .mockResolvedValueOnce(pages[2]) });
    const second = await executeMatomo(input, { query: vi.fn()
      .mockResolvedValueOnce(pages[0])
      .mockResolvedValueOnce(pages[1])
      .mockResolvedValueOnce(pages[2]) });

    expect(first.rawReport).toEqual(second.rawReport);
    const view = new DataView(first.rawReport.buffer, first.rawReport.byteOffset, first.rawReport.byteLength);
    const firstLength = view.getUint32(23, false);
    expect(first.rawReport.subarray(27, 27 + firstLength)).toEqual(pages[0].rawBytes);
  });
});
