import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInternalRequest } from "@sgeo/internal-protocol";
import { ArtifactStoreError } from "@/lib/artifacts/local-store";
import type { ArtifactStore } from "@/lib/artifacts/store";
import { createAnalysisArtifactRoute } from "./route";

const secret = "task-2-test-secret";
const runId = "run_1";
const pathname = `/api/internal/analysis-runs/${runId}/artifacts`;
const originalSecret = process.env.SGEO_INTERNAL_SECRET;
const body = new TextEncoder().encode('{"score":91}');

function checksumFor(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function store() {
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
  return { artifacts, upload };
}

function chunkedBody(
  chunks: Uint8Array[],
  onCancel?: () => void,
  keepOpen = false,
) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!keepOpen) controller.close();
    },
    cancel: onCancel,
  });
}

async function signedRequest(
  bytes = body,
  headers: Record<string, string> = {},
  method = "POST",
  timestamp = Math.floor(Date.now() / 1_000),
  chunks?: Uint8Array[],
  signedBytes = bytes,
  onCancel?: () => void,
  keepOpen = false,
) {
  const signed = await signInternalRequest(
    secret,
    method,
    pathname,
    signedBytes,
    timestamp,
  );
  return new Request(`http://localhost${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-sgeo-artifact-name": "report.json",
      "x-sgeo-artifact-sha256": checksumFor(bytes),
      "x-sgeo-timestamp": signed.timestamp,
      "x-sgeo-signature": signed.signature,
      ...headers,
    },
    body: chunks === undefined ? bytes : chunkedBody(chunks, onCancel, keepOpen),
    // Node's Request requires this for a ReadableStream request body.
    duplex: "half",
  } as RequestInit);
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
    const { artifacts } = store();
    const post = createAnalysisArtifactRoute(() => artifacts);

    const response = await post(await signedRequest(body, {}, "PUT"), {
      params: Promise.resolve({ id: runId }),
    });

    expect(response.status).toBe(405);
    expect(artifacts.beginUpload).not.toHaveBeenCalled();
  });

  it("rejects absent and expired signatures before reading or staging artifact bytes", async () => {
    const { artifacts } = store();
    const post = createAnalysisArtifactRoute(() => artifacts);
    const unsigned = new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sgeo-artifact-name": "report.json",
        "x-sgeo-artifact-sha256": checksumFor(body),
      },
      body: new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("unsigned request body must not be read");
        },
      }),
      duplex: "half",
    } as RequestInit);
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
    expect(artifacts.beginUpload).not.toHaveBeenCalled();
  });

  it("streams signed raw bytes and publishes only verified metadata", async () => {
    const { artifacts, upload } = store();
    const post = createAnalysisArtifactRoute(() => artifacts);
    let cancellations = 0;

    const response = await post(await signedRequest(
      body,
      {},
      "POST",
      Math.floor(Date.now() / 1_000),
      [body.subarray(0, 4), body.subarray(4)],
      body,
      () => {
        cancellations += 1;
      },
    ), {
      params: Promise.resolve({ id: runId }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      uri: "artifact://run_1/report.json",
      checksum: checksumFor(body),
      mediaType: "application/json",
      byteSize: body.byteLength,
    });
    expect(artifacts.beginUpload).toHaveBeenCalledWith(
      runId,
      "report.json",
      "application/json",
      expect.any(Number),
    );
    expect(upload.write).toHaveBeenNthCalledWith(1, body.subarray(0, 4));
    expect(upload.write).toHaveBeenNthCalledWith(2, body.subarray(4));
    expect(upload.commit).toHaveBeenCalledWith({
      uri: "artifact://run_1/report.json",
      checksum: checksumFor(body),
      mediaType: "application/json",
      byteSize: body.byteLength,
    });
    expect(cancellations).toBe(0);
    expect(upload.abort).not.toHaveBeenCalled();
  });

  it("accepts signed octet-stream artifact bytes", async () => {
    const { artifacts, upload } = store();
    const post = createAnalysisArtifactRoute(() => artifacts);

    const response = await post(await signedRequest(body, {
      "content-type": "application/octet-stream",
    }), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(201);
    expect(artifacts.beginUpload).toHaveBeenCalledWith(
      runId,
      "report.json",
      "application/octet-stream",
      expect.any(Number),
    );
    expect(upload.commit).toHaveBeenCalledTimes(1);
  });

  it("rejects missing artifact headers after authentication", async () => {
    const { artifacts } = store();
    const post = createAnalysisArtifactRoute(() => artifacts);

    const response = await post(await signedRequest(body, {
      "x-sgeo-artifact-name": "",
    }), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(400);
    expect(artifacts.beginUpload).not.toHaveBeenCalled();
  });

  it("never publishes a fully-shaped request with an invalid HMAC", async () => {
    const { artifacts, upload } = store();
    const post = createAnalysisArtifactRoute(() => artifacts);
    const request = await signedRequest(body, {
      "x-sgeo-signature": "0".repeat(64),
    });

    const response = await post(request, {
      params: Promise.resolve({ id: runId }),
    });

    expect(response.status).toBe(401);
    expect(artifacts.beginUpload).not.toHaveBeenCalled();
    expect(upload.write).not.toHaveBeenCalled();
    expect(upload.abort).not.toHaveBeenCalled();
    expect(upload.commit).not.toHaveBeenCalled();
  });

  it("stages then aborts when a valid claimed checksum HMAC has different bytes", async () => {
    const { artifacts, upload } = store();
    const post = createAnalysisArtifactRoute(() => artifacts);
    const claimedBytes = new TextEncoder().encode('{"score":92}');

    const response = await post(await signedRequest(body, {
      "x-sgeo-artifact-sha256": checksumFor(claimedBytes),
    }, "POST", Math.floor(Date.now() / 1_000), undefined, claimedBytes), {
      params: Promise.resolve({ id: runId }),
    });

    expect(response.status).toBe(422);
    expect(artifacts.beginUpload).toHaveBeenCalledTimes(1);
    expect(upload.write).toHaveBeenCalledTimes(1);
    expect(upload.abort).toHaveBeenCalledTimes(1);
    expect(upload.commit).not.toHaveBeenCalled();
  });

  it("rejects streamed bodies over the byte ceiling without publishing", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { artifacts, upload } = store();
    const post = createAnalysisArtifactRoute(() => artifacts, 3);
    let cancellations = 0;

    const response = await post(await signedRequest(
      bytes,
      { "content-type": "application/octet-stream" },
      "POST",
      Math.floor(Date.now() / 1_000),
      [bytes.subarray(0, 2), bytes.subarray(2)],
      bytes,
      () => {
        cancellations += 1;
      },
      true,
    ), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(413);
    expect(cancellations).toBe(1);
    expect(upload.write).toHaveBeenCalledTimes(1);
    expect(upload.abort).toHaveBeenCalledTimes(1);
    expect(upload.commit).not.toHaveBeenCalled();
  });

  it("cancels and aborts staging when artifact stream reading fails", async () => {
    const { artifacts, upload } = store();
    const post = createAnalysisArtifactRoute(() => artifacts);
    const request = await signedRequest();
    const order: string[] = [];
    const reader = {
      read: vi.fn().mockRejectedValue(new Error("stream failed")),
      cancel: vi.fn().mockImplementation(async () => {
        order.push("cancel");
      }),
      releaseLock: vi.fn().mockImplementation(() => {
        order.push("release");
      }),
    };
    Object.defineProperty(request, "body", {
      value: { getReader: () => reader },
    });

    const response = await post(request, {
      params: Promise.resolve({ id: runId }),
    });

    expect(response.status).toBe(500);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["cancel", "release"]);
    expect(upload.abort).toHaveBeenCalledTimes(1);
    expect(upload.commit).not.toHaveBeenCalled();
  });

  it("maps unavailable artifact storage to a safe 503 response", async () => {
    const { artifacts } = store();
    artifacts.beginUpload.mockRejectedValueOnce(new ArtifactStoreError(
      "ARTIFACT_UNAVAILABLE",
    ));
    const post = createAnalysisArtifactRoute(() => artifacts);

    const response = await post(await signedRequest(), {
      params: Promise.resolve({ id: runId }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Artifact storage is temporarily unavailable",
      code: "ARTIFACT_UNAVAILABLE",
    });
  });

  it("rejects unsafe artifact names and unsupported media types", async () => {
    const { artifacts } = store();
    const post = createAnalysisArtifactRoute(() => artifacts);

    const unsafeName = await post(await signedRequest(body, {
      "x-sgeo-artifact-name": "../report.json",
    }), { params: Promise.resolve({ id: runId }) });
    const unsupportedMediaType = await post(await signedRequest(body, {
      "content-type": "text/plain",
    }), { params: Promise.resolve({ id: runId }) });

    expect(unsafeName.status).toBe(400);
    expect(unsupportedMediaType.status).toBe(415);
    expect(artifacts.beginUpload).not.toHaveBeenCalled();
  });
});
