import { describe, expect, expectTypeOf, it } from "vitest";
import {
  analysisEnvelopeSchema,
  type AnalysisStatus,
  type ObservationSurface,
} from "./index";

const validEnvelope = {
  contractVersion: "1",
  runId: "run_1",
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: "market_1",
  source: "siteone",
  sourceVersion: "2.5.1",
  adapterVersion: "1.0.0",
  status: "succeeded",
  startedAt: "2026-07-31T01:00:00.000Z",
  finishedAt: "2026-07-31T01:05:00.000Z",
  rawArtifact: {
    uri: "artifact://run_1/report.json",
    checksum: "sha256:4f89b3c2d0e17a654f89b3c2d0e17a654f89b3c2d0e17a654f89b3c2d0e17a65",
    mediaType: "application/json",
    byteSize: 128,
  },
  observations: [{
    kind: "http_status",
    subject: "https://example.com/",
    value: { status: 200 },
    observedAt: "2026-07-31T01:04:00.000Z",
  }],
  error: null,
};

describe("analysisEnvelopeSchema", () => {
  it("exports the public status and surface types", () => {
    expectTypeOf<AnalysisStatus>().toEqualTypeOf<
      "queued" | "running" | "succeeded" | "partial" |
      "retrying" | "failed" | "cancelled"
    >();
    expectTypeOf<ObservationSurface>().toEqualTypeOf<"api" | "consumer_ui" | "manual">();
  });

  it("accepts a versioned owned result", () => {
    expect(analysisEnvelopeSchema.parse(validEnvelope)).toEqual(validEnvelope);
  });

  it("rejects a result without site ownership", () => {
    const { siteId: _siteId, ...invalid } = validEnvelope;
    expect(analysisEnvelopeSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires an error for a failed result", () => {
    expect(analysisEnvelopeSchema.safeParse({
      ...validEnvelope,
      status: "failed",
      error: null,
    }).success).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["bigint", BigInt(1)],
  ])("rejects %s in observation values", (_label, invalidValue) => {
    expect(analysisEnvelopeSchema.safeParse({
      ...validEnvelope,
      observations: [{
        ...validEnvelope.observations[0],
        value: { invalidValue },
      }],
    }).success).toBe(false);
  });

  it.each([
    ["a short digest", "sha256:4f89b3c2d0e17a65"],
    ["non-hex characters", `sha256:${"g".repeat(64)}`],
  ])("rejects checksums with %s", (_label, checksum) => {
    expect(analysisEnvelopeSchema.safeParse({
      ...validEnvelope,
      rawArtifact: {
        ...validEnvelope.rawArtifact,
        checksum,
      },
    }).success).toBe(false);
  });

  it("rejects a finished time before the start time", () => {
    expect(analysisEnvelopeSchema.safeParse({
      ...validEnvelope,
      finishedAt: "2026-07-31T00:59:59.999Z",
    }).success).toBe(false);
  });

  it.each([
    ["equal to", validEnvelope.startedAt],
    ["later than", validEnvelope.finishedAt],
  ])("accepts a finished time %s the start time", (_label, finishedAt) => {
    expect(analysisEnvelopeSchema.safeParse({
      ...validEnvelope,
      finishedAt,
    }).success).toBe(true);
  });
});
