import { describe, expect, it, vi } from "vitest";

import type { AnalysisEnvelope } from "@sgeo/analysis-contract";
import { AnalysisRepositoryError } from "@/lib/analysis/repository";
import { ArtifactStoreError } from "@/lib/artifacts/local-store";
import type { ArtifactStore } from "@/lib/artifacts/store";
import {
  AnalysisIngestError,
  AnalysisIngestService,
} from "@/lib/analysis/ingest-service";

const checksum = `sha256:${"a".repeat(64)}`;
const envelope: AnalysisEnvelope = {
  contractVersion: "1",
  runId: "run_1",
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: null,
  source: "siteone",
  sourceVersion: "2.5.1",
  adapterVersion: "1.0.0",
  status: "succeeded",
  startedAt: "2026-08-01T01:00:00.000Z",
  finishedAt: "2026-08-01T01:01:00.000Z",
  rawArtifact: {
    uri: "artifact://run_1/report.json",
    checksum,
    mediaType: "application/json",
    byteSize: 42,
  },
  observations: [],
  error: null,
};

function metadata(source: AnalysisEnvelope = envelope) {
  return {
    uri: source.rawArtifact!.uri,
    checksum: source.rawArtifact!.checksum,
    mediaType: source.rawArtifact!.mediaType,
    byteSize: source.rawArtifact!.byteSize,
  };
}

function dependencies() {
  const order: string[] = [];
  const repository = {
    ingest: vi.fn().mockImplementation(async (
      source: AnalysisEnvelope,
      verifyUploadedArtifact: (artifact: NonNullable<AnalysisEnvelope["rawArtifact"]>) => Promise<unknown>,
    ) => {
      order.push("transaction");
      if (source.rawArtifact !== null) {
        await verifyUploadedArtifact(source.rawArtifact);
      }
      order.push("write");
      return { duplicate: false };
    }),
  };
  const artifacts = {
    put: vi.fn(),
    beginUpload: vi.fn(),
    get: vi.fn(),
    getMetadata: vi.fn().mockImplementation(async () => {
      order.push("metadata");
      return metadata();
    }),
  } satisfies ArtifactStore;
  return { artifacts, order, repository };
}

describe("AnalysisIngestService", () => {
  it("verifies uploaded artifact metadata inside the repository transaction", async () => {
    const { artifacts, order, repository } = dependencies();
    const service = new AnalysisIngestService(repository, artifacts);

    await expect(service.ingest(envelope)).resolves.toEqual({
      runId: "run_1",
      status: "accepted",
      duplicate: false,
    });
    repository.ingest.mockImplementationOnce(async (
      source: AnalysisEnvelope,
      verifyUploadedArtifact: (artifact: NonNullable<AnalysisEnvelope["rawArtifact"]>) => Promise<unknown>,
    ) => {
      order.push("transaction");
      if (source.rawArtifact !== null) {
        await verifyUploadedArtifact(source.rawArtifact);
      }
      order.push("write");
      return { duplicate: true };
    });
    await expect(service.ingest(envelope)).resolves.toEqual({
      runId: "run_1",
      status: "accepted",
      duplicate: true,
    });

    expect(order).toEqual([
      "transaction",
      "metadata",
      "write",
      "transaction",
      "metadata",
      "write",
    ]);
    expect(artifacts.getMetadata).toHaveBeenCalledWith(
      "artifact://run_1/report.json",
    );
    expect(repository.ingest).toHaveBeenCalledWith(
      envelope,
      expect.any(Function),
    );
  });

  it("maps a repository ownership failure to a stable run error", async () => {
    const { artifacts, repository } = dependencies();
    repository.ingest.mockRejectedValueOnce(new AnalysisRepositoryError(
      "ANALYSIS_OWNERSHIP_MISMATCH",
    ));
    const service = new AnalysisIngestService(repository, artifacts);

    await expect(service.ingest({ ...envelope, clientId: "client_b" }))
      .rejects.toEqual(expect.objectContaining({
        name: "AnalysisIngestError",
        code: "RUN_OWNERSHIP_MISMATCH",
      }));
  });

  it("rejects a changed stored artifact checksum before repository writes", async () => {
    const { artifacts, order, repository } = dependencies();
    artifacts.getMetadata.mockImplementationOnce(async () => {
      order.push("metadata");
      return {
        ...metadata(),
        checksum: `sha256:${"b".repeat(64)}`,
      };
    });
    const service = new AnalysisIngestService(repository, artifacts);

    await expect(service.ingest(envelope)).rejects.toEqual(
      expect.objectContaining({
        name: "AnalysisIngestError",
        code: "RUN_CHECKSUM_CONFLICT",
      }),
    );
    expect(repository.ingest).toHaveBeenCalledOnce();
    expect(order).toEqual(["transaction", "metadata"]);
  });

  it("maps transaction-scoped artifact metadata failures to a retryable error", async () => {
    const { artifacts, order, repository } = dependencies();
    artifacts.getMetadata.mockRejectedValueOnce(new ArtifactStoreError(
      "ARTIFACT_UNAVAILABLE",
    ));
    const service = new AnalysisIngestService(repository, artifacts);

    await expect(service.ingest(envelope)).rejects.toEqual(
      expect.objectContaining({ code: "ARTIFACT_UNAVAILABLE" }),
    );
    expect(order).toEqual(["transaction"]);
    expect(repository.ingest).toHaveBeenCalledOnce();
  });

  it("validates the envelope before checking artifact storage", async () => {
    const { artifacts, repository } = dependencies();
    const service = new AnalysisIngestService(repository, artifacts);

    await expect(service.ingest({ ...envelope, contractVersion: "2" } as never))
      .rejects.toMatchObject({ name: "ZodError" });
    expect(artifacts.getMetadata).not.toHaveBeenCalled();
    expect(repository.ingest).not.toHaveBeenCalled();
  });

  it("passes an explicit null artifact proof for artifact-free envelopes", async () => {
    const { artifacts, repository } = dependencies();
    const service = new AnalysisIngestService(repository, artifacts);
    const withoutArtifact = { ...envelope, rawArtifact: null };

    await service.ingest(withoutArtifact);

    expect(artifacts.getMetadata).not.toHaveBeenCalled();
    expect(repository.ingest).toHaveBeenCalledWith(
      withoutArtifact,
      expect.any(Function),
    );
  });

  it("exposes stable error instances", () => {
    expect(new AnalysisIngestError("RUN_CHECKSUM_CONFLICT"))
      .toMatchObject({
        name: "AnalysisIngestError",
        code: "RUN_CHECKSUM_CONFLICT",
      });
  });
});
