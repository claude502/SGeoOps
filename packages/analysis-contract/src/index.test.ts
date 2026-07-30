import { describe, expect, it } from "vitest";
import { analysisEnvelopeSchema } from "./index";

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
    checksum: "sha256:4f89b3c2d0e17a65",
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
});
