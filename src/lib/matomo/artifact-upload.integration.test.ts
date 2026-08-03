import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactStore } from "@/lib/artifacts/store";
import { createAnalysisArtifactRoute } from "../../app/api/internal/analysis-runs/[id]/artifacts/route";
import { createAnalysisArtifactReconcileRoute } from "../../app/api/internal/analysis-runs/[id]/artifacts/[name]/reconcile/route";
import { SgeoOpsClient } from "../../../geo-worker/src/clients/sgeo-ops";

const secret = "matomo-artifact-chain-secret";
const runId = "run_matomo_1";
const mediaType = "application/vnd.sgeo.matomo-reports.v1";
const originalSecret = process.env.SGEO_INTERNAL_SECRET;

function routeBackedClient() {
  const upload = {
    write: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockImplementation(async (expected) => expected),
    abort: vi.fn().mockResolvedValue(undefined),
  };
  const artifacts = {
    put: vi.fn(),
    beginUpload: vi.fn().mockResolvedValue(upload),
    getMetadata: vi.fn(),
    get: vi.fn(),
  } satisfies ArtifactStore;
  const post = createAnalysisArtifactRoute(() => artifacts);
  const reconcile = createAnalysisArtifactReconcileRoute(() => artifacts);
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(String(input), init);
    if (new URL(request.url).pathname.endsWith("/reconcile")) {
      return reconcile(request, {
        params: Promise.resolve({ id: runId, name: "matomo-reports-v1.bin" }),
      });
    }
    return post(request, { params: Promise.resolve({ id: runId }) });
  });
  return {
    artifacts,
    upload,
    client: new SgeoOpsClient({ baseUrl: "http://localhost", secret, fetch }),
  };
}

beforeEach(() => {
  process.env.SGEO_INTERNAL_SECRET = secret;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.SGEO_INTERNAL_SECRET;
  else process.env.SGEO_INTERNAL_SECRET = originalSecret;
});

describe("Matomo artifact upload chain", () => {
  it("stores the signed Matomo report bundle with its exact vendor media type", async () => {
    const bytes = new TextEncoder().encode("SGEO-MATOMO-REPORTS-V1\n");
    const { artifacts, upload, client } = routeBackedClient();

    await expect(client.uploadArtifact(
      runId,
      "matomo-reports-v1.bin",
      bytes,
      mediaType,
    )).resolves.toMatchObject({ mediaType, byteSize: bytes.byteLength });

    expect(artifacts.beginUpload).toHaveBeenCalledWith(
      runId,
      "matomo-reports-v1.bin",
      mediaType,
      expect.any(Number),
    );
    expect(upload.write).toHaveBeenCalledWith(bytes);
  });

  it("still rejects an unsupported vendor media type", async () => {
    const bytes = new TextEncoder().encode("unsafe");
    const { artifacts, client } = routeBackedClient();

    await expect(client.uploadArtifact(
      runId,
      "unsafe.bin",
      bytes,
      "application/vnd.sgeo.unsupported",
    )).rejects.toMatchObject({ name: "SgeoOpsClientError", retryable: false });
    expect(artifacts.beginUpload).not.toHaveBeenCalled();
  });

  it("reconciles a committed Matomo report through the signed control route", async () => {
    const bytes = new TextEncoder().encode("SGEO-MATOMO-REPORTS-V1\n");
    const { artifacts, client } = routeBackedClient();
    const artifact = {
      uri: `artifact://${runId}/matomo-reports-v1.bin`,
      checksum: `sha256:${"a".repeat(64)}`,
      mediaType,
      byteSize: bytes.byteLength,
    };
    artifacts.getMetadata.mockResolvedValue(artifact);

    await expect(client.reconcileArtifact(runId, "matomo-reports-v1.bin", artifact))
      .resolves.toBe(true);
    expect(artifacts.getMetadata).toHaveBeenCalledWith(artifact.uri);
  });
});
