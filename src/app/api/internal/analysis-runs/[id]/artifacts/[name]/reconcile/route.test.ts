import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInternalRequest } from "@sgeo/internal-protocol";
import { ArtifactStoreError } from "@/lib/artifacts/local-store";
import type { ArtifactStore, StoredArtifact } from "@/lib/artifacts/store";
import { createAnalysisArtifactReconcileRoute } from "./route";

const secret = "artifact-reconcile-test-secret";
const runId = "run_1";
const name = "matomo-reports-v1.bin";
const pathname = `/api/internal/analysis-runs/${runId}/artifacts/${name}/reconcile`;
const originalSecret = process.env.SGEO_INTERNAL_SECRET;
const artifact: StoredArtifact = {
  uri: `artifact://${runId}/${name}`,
  checksum: `sha256:${"a".repeat(64)}`,
  mediaType: "application/vnd.sgeo.matomo-reports.v1",
  byteSize: 23,
};

function store(metadata: StoredArtifact | Error = artifact) {
  const artifacts = {
    put: vi.fn(),
    beginUpload: vi.fn(),
    getMetadata: vi.fn().mockImplementation(async () => {
      if (metadata instanceof Error) throw metadata;
      return metadata;
    }),
    get: vi.fn(),
  } satisfies ArtifactStore;
  return artifacts;
}

async function signedRequest(
  payload: unknown = { artifact },
  signedPath = pathname,
  rawBody?: string,
) {
  const body = rawBody ?? JSON.stringify(payload);
  const signed = await signInternalRequest(secret, "POST", signedPath, body);
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sgeo-timestamp": signed.timestamp,
      "x-sgeo-signature": signed.signature,
    },
    body,
  });
}

beforeEach(() => { process.env.SGEO_INTERNAL_SECRET = secret; });
afterEach(() => {
  if (originalSecret === undefined) delete process.env.SGEO_INTERNAL_SECRET;
  else process.env.SGEO_INTERNAL_SECRET = originalSecret;
});

describe("POST /api/internal/analysis-runs/[id]/artifacts/[name]/reconcile", () => {
  it("returns exists only when the signed deterministic artifact metadata matches exactly", async () => {
    const artifacts = store();
    const post = createAnalysisArtifactReconcileRoute(() => artifacts);

    const response = await post(await signedRequest(), {
      params: Promise.resolve({ id: runId, name }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ exists: true });
    expect(artifacts.getMetadata).toHaveBeenCalledWith(artifact.uri);
  });

  it("returns a safe absence result for a signed missing artifact", async () => {
    const artifacts = store(new ArtifactStoreError("ARTIFACT_NOT_FOUND"));
    const post = createAnalysisArtifactReconcileRoute(() => artifacts);

    const response = await post(await signedRequest(), {
      params: Promise.resolve({ id: runId, name }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ exists: false });
  });

  it("rejects invalid metadata and rejects signed metadata that conflicts with stored evidence", async () => {
    const artifacts = store({ ...artifact, checksum: `sha256:${"b".repeat(64)}` });
    const post = createAnalysisArtifactReconcileRoute(() => artifacts);

    const invalid = await post(await signedRequest({ artifact: { ...artifact, uri: "artifact://other/report.bin" } }), {
      params: Promise.resolve({ id: runId, name }),
    });
    const conflict = await post(await signedRequest(), {
      params: Promise.resolve({ id: runId, name }),
    });

    expect(invalid.status).toBe(400);
    expect(conflict.status).toBe(409);
  });

  it("binds the signature to the reconciliation route and verifies malformed bodies before parsing errors", async () => {
    const artifacts = store();
    const post = createAnalysisArtifactReconcileRoute(() => artifacts);
    const malformedBody = "{";
    const signed = await signedRequest(undefined, pathname, malformedBody);
    const forged = await signedRequest(
      undefined,
      `/api/internal/analysis-runs/${runId}/artifacts/${name}`,
      malformedBody,
    );

    const validMalformed = await post(signed, { params: Promise.resolve({ id: runId, name }) });
    const replayed = await post(forged, { params: Promise.resolve({ id: runId, name }) });

    expect(validMalformed.status).toBe(400);
    expect(replayed.status).toBe(401);
    expect(artifacts.getMetadata).not.toHaveBeenCalled();
  });
});
