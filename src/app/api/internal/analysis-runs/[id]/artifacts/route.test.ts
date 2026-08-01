import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInternalRequest } from "@sgeo/internal-protocol";
import type { ArtifactStore } from "@/lib/artifacts/store";
import { createAnalysisArtifactRoute } from "./route";

const secret = "task-2-test-secret";
const runId = "run_1";
const pathname = `/api/internal/analysis-runs/${runId}/artifacts`;
const originalSecret = process.env.SGEO_INTERNAL_SECRET;
const body = new TextEncoder().encode('{"score":91}');
const checksum = `sha256:${createHash("sha256").update(body).digest("hex")}`;

function store() {
  return {
    put: vi.fn().mockResolvedValue({
      uri: "artifact://run_1/report.json",
      checksum,
      mediaType: "application/json",
      byteSize: body.byteLength,
    }),
    getMetadata: vi.fn(),
    get: vi.fn(),
  } satisfies ArtifactStore;
}

async function signedRequest(
  bytes = body,
  headers: Record<string, string> = {},
  method = "POST",
  timestamp = Math.floor(Date.now() / 1_000),
) {
  const signed = await signInternalRequest(
    secret,
    method,
    pathname,
    bytes,
    timestamp,
  );
  return new Request(`http://localhost${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-sgeo-artifact-name": "report.json",
      "x-sgeo-artifact-sha256": checksum,
      "x-sgeo-timestamp": signed.timestamp,
      "x-sgeo-signature": signed.signature,
      ...headers,
    },
    body: bytes,
  });
}

beforeEach(() => {
  process.env.SGEO_INTERNAL_SECRET = secret;
});

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.SGEO_INTERNAL_SECRET;
  } else {
    process.env.SGEO_INTERNAL_SECRET = originalSecret;
  }
});

describe("POST /api/internal/analysis-runs/[id]/artifacts", () => {
  it("rejects a valid signature for another HTTP method", async () => {
    const artifacts = store();
    const post = createAnalysisArtifactRoute(() => artifacts);

    const response = await post(await signedRequest(body, {}, "PUT"), {
      params: Promise.resolve({ id: runId }),
    });

    expect(response.status).toBe(405);
    expect(artifacts.put).not.toHaveBeenCalled();
  });

  it("rejects absent and expired signatures before artifact persistence", async () => {
    const artifacts = store();
    const post = createAnalysisArtifactRoute(() => artifacts);
    const unsigned = new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sgeo-artifact-name": "report.json",
        "x-sgeo-artifact-sha256": checksum,
      },
      body,
    });
    const expired = await signedRequest(
      body,
      {},
      "POST",
      Math.floor(Date.now() / 1_000) - 301,
    );

    await expect(post(unsigned, { params: Promise.resolve({ id: runId }) }))
      .resolves.toMatchObject({ status: 401 });
    await expect(post(expired, { params: Promise.resolve({ id: runId }) }))
      .resolves.toMatchObject({ status: 401 });
    expect(artifacts.put).not.toHaveBeenCalled();
  });

  it("stores signed raw bytes and returns only verified metadata", async () => {
    const artifacts = store();
    const post = createAnalysisArtifactRoute(() => artifacts);

    const response = await post(await signedRequest(), {
      params: Promise.resolve({ id: runId }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      uri: "artifact://run_1/report.json",
      checksum,
      mediaType: "application/json",
      byteSize: body.byteLength,
    });
    expect(artifacts.put).toHaveBeenCalledWith(
      runId,
      "report.json",
      body,
      "application/json",
    );
  });

  it("accepts signed octet-stream artifact bytes", async () => {
    const artifacts = store();
    artifacts.put.mockResolvedValueOnce({
      uri: "artifact://run_1/report.json",
      checksum,
      mediaType: "application/octet-stream",
      byteSize: body.byteLength,
    });
    const post = createAnalysisArtifactRoute(() => artifacts);

    const response = await post(await signedRequest(body, {
      "content-type": "application/octet-stream",
    }), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(201);
    expect(artifacts.put).toHaveBeenCalledWith(
      runId,
      "report.json",
      body,
      "application/octet-stream",
    );
  });

  it("rejects missing artifact headers after authentication", async () => {
    const artifacts = store();
    const post = createAnalysisArtifactRoute(() => artifacts);

    const response = await post(await signedRequest(body, {
      "x-sgeo-artifact-name": "",
    }), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(400);
    expect(artifacts.put).not.toHaveBeenCalled();
  });

  it("rejects a bad signature before artifact persistence", async () => {
    const artifacts = store();
    const post = createAnalysisArtifactRoute(() => artifacts);
    const request = await signedRequest(body, {
      "x-sgeo-signature": "0".repeat(64),
    });

    const response = await post(request, {
      params: Promise.resolve({ id: runId }),
    });

    expect(response.status).toBe(401);
    expect(artifacts.put).not.toHaveBeenCalled();
  });

  it("rejects a signed checksum that does not match the exact bytes", async () => {
    const artifacts = store();
    const post = createAnalysisArtifactRoute(() => artifacts);

    const response = await post(await signedRequest(body, {
      "x-sgeo-artifact-sha256": `sha256:${"b".repeat(64)}`,
    }), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(422);
    expect(artifacts.put).not.toHaveBeenCalled();
  });

  it("rejects unsafe artifact names and unsupported media types", async () => {
    const artifacts = store();
    const post = createAnalysisArtifactRoute(() => artifacts);

    const unsafeName = await post(await signedRequest(body, {
      "x-sgeo-artifact-name": "../report.json",
    }), { params: Promise.resolve({ id: runId }) });
    const unsupportedMediaType = await post(await signedRequest(body, {
      "content-type": "text/plain",
    }), { params: Promise.resolve({ id: runId }) });

    expect(unsafeName.status).toBe(400);
    expect(unsupportedMediaType.status).toBe(415);
    expect(artifacts.put).not.toHaveBeenCalled();
  });
});
