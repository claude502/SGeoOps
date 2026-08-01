import type { AnalysisEnvelope } from "@sgeo/analysis-contract";
import { describe, expect, it, vi } from "vitest";

const triggerMocks = vi.hoisted(() => ({
  task: vi.fn((definition: { id: string }) => ({ id: definition.id })),
  info: vi.fn(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  task: triggerMocks.task,
  logger: { info: triggerMocks.info },
}));

const { runSiteOneCrawl, siteOneCrawlTask } = await import("./siteone-crawl");

const input = {
  runId: "run_123",
  clientId: "client_123",
  brandId: "brand_123",
  siteId: "site_123",
  siteMarketId: null,
  url: "https://example.test/",
  maxUrls: 25,
  timeoutSeconds: 30,
};

const envelope: AnalysisEnvelope = {
  contractVersion: "1",
  runId: input.runId,
  clientId: input.clientId,
  brandId: input.brandId,
  siteId: input.siteId,
  siteMarketId: input.siteMarketId,
  source: "siteone",
  sourceVersion: "2.5.1",
  adapterVersion: "1.0.0",
  status: "succeeded",
  startedAt: "2026-08-01T00:00:00.000Z",
  finishedAt: "2026-08-01T00:00:01.000Z",
  rawArtifact: null,
  observations: [],
  error: null,
};

describe("siteOneCrawlTask", () => {
  it("registers a bounded Trigger v4 task", () => {
    expect(siteOneCrawlTask.id).toBe("siteone-crawl");
    const [definition] = triggerMocks.task.mock.calls[0] as [
      Record<string, unknown>,
    ];

    expect(definition).toMatchObject({
      id: "siteone-crawl",
      queue: { name: "siteone", concurrencyLimit: 2 },
      machine: "medium-1x",
      maxDuration: 900,
    });
  });

  it("uploads the untouched report before ingesting an envelope linked to its metadata", async () => {
    const order: string[] = [];
    const rawReport = new TextEncoder().encode('{"crawler":"siteone"}\n');
    const uploadArtifact = vi.fn(async () => {
      order.push("upload");
      return {
        uri: "artifact://run_123/siteone-report.json",
        checksum: `sha256:${"a".repeat(64)}`,
        mediaType: "application/json",
        byteSize: rawReport.byteLength,
      };
    });
    const ingest = vi.fn(async (received: AnalysisEnvelope) => {
      order.push("ingest");
      expect(received.rawArtifact).toEqual({
        uri: "artifact://run_123/siteone-report.json",
        checksum: `sha256:${"a".repeat(64)}`,
        mediaType: "application/json",
        byteSize: rawReport.byteLength,
      });
    });

    const result = await runSiteOneCrawl(input, {
      execute: vi.fn(async () => ({ envelope, rawReport })),
      client: { uploadArtifact, ingest },
    });

    expect(order).toEqual(["upload", "ingest"]);
    expect(uploadArtifact).toHaveBeenCalledWith(
      input.runId,
      "siteone-report.json",
      rawReport,
      "application/json",
    );
    expect(result.rawArtifact).not.toBeNull();
  });
});
