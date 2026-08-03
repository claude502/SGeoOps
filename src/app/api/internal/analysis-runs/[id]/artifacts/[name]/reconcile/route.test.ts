import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInternalRequest } from "@sgeo/internal-protocol";
import { ArtifactStoreError } from "@/lib/artifacts/local-store";
import type { ArtifactStore, StoredArtifact } from "@/lib/artifacts/store";
import { MatomoControlError } from "@/lib/matomo/control-plane";
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
const scope = {
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: null,
  integrationId: "integration_1",
  endpoint: "https://analytics.example",
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

function control(error?: Error) {
  return {
    assertOwnedScope: vi.fn().mockImplementation(async () => {
      if (error !== undefined) throw error;
    }),
  };
}

async function signedRequest(
  payload: unknown = { scope, artifact },
  signedPath = pathname,
  rawBody?: string,
  requestPath = pathname,
) {
  const body = rawBody ?? JSON.stringify(payload);
  const signed = await signInternalRequest(secret, "POST", signedPath, body);
  return new Request(`http://localhost${requestPath}`, {
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
    const owned = control();
    const post = createAnalysisArtifactReconcileRoute(() => artifacts, () => owned);

    const response = await post(await signedRequest(), {
      params: Promise.resolve({ id: runId, name }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ exists: true });
    expect(owned.assertOwnedScope).toHaveBeenCalledWith({ runId, ...scope });
    expect(artifacts.getMetadata).toHaveBeenCalledWith(artifact.uri);
  });

  it("returns a safe absence result for a signed missing artifact", async () => {
    const artifacts = store(new ArtifactStoreError("ARTIFACT_NOT_FOUND"));
    const post = createAnalysisArtifactReconcileRoute(() => artifacts, control);

    const response = await post(await signedRequest(), {
      params: Promise.resolve({ id: runId, name }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ exists: false });
  });

  it("rejects invalid metadata and rejects signed metadata that conflicts with stored evidence", async () => {
    const artifacts = store({ ...artifact, checksum: `sha256:${"b".repeat(64)}` });
    const post = createAnalysisArtifactReconcileRoute(() => artifacts, control);

    const invalid = await post(await signedRequest({ scope, artifact: { ...artifact, uri: "artifact://other/report.bin" } }), {
      params: Promise.resolve({ id: runId, name }),
    });
    const conflict = await post(await signedRequest(), {
      params: Promise.resolve({ id: runId, name }),
    });

    expect(invalid.status).toBe(400);
    expect(conflict.status).toBe(409);
  });

  it.each([
    ["cross-client", { ...scope, clientId: "client_2" }],
    ["cross-integration", { ...scope, integrationId: "integration_2" }],
    ["wrong-source", scope],
  ])("does not reveal artifact existence when owned scope is %s", async (_label, requestedScope) => {
    const existing = store();
    const missing = store(new ArtifactStoreError("ARTIFACT_NOT_FOUND"));
    const rejected = new MatomoControlError("RESOURCE_NOT_FOUND");
    const existingControl = control(rejected);
    const missingControl = control(rejected);
    const existingPost = createAnalysisArtifactReconcileRoute(() => existing, () => existingControl);
    const missingPost = createAnalysisArtifactReconcileRoute(() => missing, () => missingControl);

    const existingResponse = await existingPost(await signedRequest({ scope: requestedScope, artifact }), {
      params: Promise.resolve({ id: runId, name }),
    });
    const missingResponse = await missingPost(await signedRequest({ scope: requestedScope, artifact }), {
      params: Promise.resolve({ id: runId, name }),
    });

    expect(existingResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);
    await expect(existingResponse.json()).resolves.toEqual({
      error: "Matomo control request failed",
      code: "CONTROL_SCOPE_NOT_FOUND",
    });
    await expect(missingResponse.json()).resolves.toEqual({
      error: "Matomo control request failed",
      code: "CONTROL_SCOPE_NOT_FOUND",
    });
    expect(existingControl.assertOwnedScope).toHaveBeenCalledWith({ runId, ...requestedScope });
    expect(missingControl.assertOwnedScope).toHaveBeenCalledWith({ runId, ...requestedScope });
    expect(existing.getMetadata).not.toHaveBeenCalled();
    expect(missing.getMetadata).not.toHaveBeenCalled();
  });

  it("rejects non-Matomo artifact facts without revealing whether storage has evidence", async () => {
    const wrongName = "other-report.bin";
    const wrongNamePath = `/api/internal/analysis-runs/${runId}/artifacts/${wrongName}/reconcile`;
    const namedArtifact = { ...artifact, uri: `artifact://${runId}/${wrongName}` };
    const nameExisting = store();
    const nameMissing = store(new ArtifactStoreError("ARTIFACT_NOT_FOUND"));
    const mimeExisting = store();
    const mimeMissing = store(new ArtifactStoreError("ARTIFACT_NOT_FOUND"));
    const sizeExisting = store();
    const sizeMissing = store(new ArtifactStoreError("ARTIFACT_NOT_FOUND"));

    const nameResponse = await createAnalysisArtifactReconcileRoute(() => nameExisting, control)(
      await signedRequest(
        { scope, artifact: namedArtifact },
        wrongNamePath,
        undefined,
        wrongNamePath,
      ),
      { params: Promise.resolve({ id: runId, name: wrongName }) },
    );
    const missingNameResponse = await createAnalysisArtifactReconcileRoute(() => nameMissing, control)(
      await signedRequest(
        { scope, artifact: namedArtifact },
        wrongNamePath,
        undefined,
        wrongNamePath,
      ),
      { params: Promise.resolve({ id: runId, name: wrongName }) },
    );
    const mimeResponse = await createAnalysisArtifactReconcileRoute(() => mimeExisting, control)(await signedRequest({
      scope,
      artifact: { ...artifact, mediaType: "application/json" },
    }), { params: Promise.resolve({ id: runId, name }) });
    const missingMimeResponse = await createAnalysisArtifactReconcileRoute(() => mimeMissing, control)(await signedRequest({
      scope,
      artifact: { ...artifact, mediaType: "application/json" },
    }), { params: Promise.resolve({ id: runId, name }) });
    const sizeResponse = await createAnalysisArtifactReconcileRoute(() => sizeExisting, control)(await signedRequest({
      scope,
      artifact: { ...artifact, byteSize: 4 * 1024 * 1024 + 1 },
    }), { params: Promise.resolve({ id: runId, name }) });
    const missingSizeResponse = await createAnalysisArtifactReconcileRoute(() => sizeMissing, control)(await signedRequest({
      scope,
      artifact: { ...artifact, byteSize: 4 * 1024 * 1024 + 1 },
    }), { params: Promise.resolve({ id: runId, name }) });

    expect(nameResponse.status).toBe(400);
    expect(missingNameResponse.status).toBe(400);
    expect(mimeResponse.status).toBe(400);
    expect(missingMimeResponse.status).toBe(400);
    expect(sizeResponse.status).toBe(400);
    expect(missingSizeResponse.status).toBe(400);
    for (const artifacts of [
      nameExisting,
      nameMissing,
      mimeExisting,
      mimeMissing,
      sizeExisting,
      sizeMissing,
    ]) {
      expect(artifacts.getMetadata).not.toHaveBeenCalled();
    }
  });

  it("binds the signature to the reconciliation route and verifies malformed bodies before parsing errors", async () => {
    const artifacts = store();
    const post = createAnalysisArtifactReconcileRoute(() => artifacts, control);
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
