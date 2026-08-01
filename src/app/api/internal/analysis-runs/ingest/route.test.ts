import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalysisEnvelope } from "@sgeo/analysis-contract";
import { signInternalRequest } from "@sgeo/internal-protocol";
import { AnalysisIngestError } from "@/lib/analysis/ingest-service";
import { createAnalysisIngestRoute } from "./route";

const secret = "task-2-test-secret";
const pathname = "/api/internal/analysis-runs/ingest";
const originalSecret = process.env.SGEO_INTERNAL_SECRET;
const originalArtifactRoot = process.env.SGEO_ARTIFACT_ROOT;
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
  rawArtifact: null,
  observations: [],
  error: null,
};

async function signedRequest(
  rawBody: string,
  timestamp = Math.floor(Date.now() / 1_000),
  contentType = "application/json",
  method = "POST",
  headers: Record<string, string> = {},
  chunks?: Uint8Array[],
) {
  const bytes = new TextEncoder().encode(rawBody);
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
      "content-type": contentType,
      "x-sgeo-timestamp": signed.timestamp,
      "x-sgeo-signature": signed.signature,
      ...headers,
    },
    body: chunks === undefined ? bytes : new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
}

function service() {
  return {
    ingest: vi.fn().mockResolvedValue({
      runId: "run_1",
      status: "accepted" as const,
      duplicate: false,
    }),
  };
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
  if (originalArtifactRoot === undefined) {
    delete process.env.SGEO_ARTIFACT_ROOT;
  } else {
    process.env.SGEO_ARTIFACT_ROOT = originalArtifactRoot;
  }
});

describe("POST /api/internal/analysis-runs/ingest", () => {
  it("rejects a valid signature for another HTTP method", async () => {
    const created = service();
    const post = createAnalysisIngestRoute(() => created);

    const response = await post(await signedRequest(
      JSON.stringify(envelope),
      Math.floor(Date.now() / 1_000),
      "application/json",
      "PUT",
    ));

    expect(response.status).toBe(405);
    expect(created.ingest).not.toHaveBeenCalled();
  });

  it("rejects an unsigned request before constructing the service", async () => {
    const createService = vi.fn(service);
    const post = createAnalysisIngestRoute(createService);

    const response = await post(new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }));

    expect(response.status).toBe(401);
    expect(createService).not.toHaveBeenCalled();
  });

  it("rejects missing and expired authentication without reading the body", async () => {
    const created = service();
    const post = createAnalysisIngestRoute(() => created);
    const unreadableBody = () => new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("unauthenticated body must not be read");
      },
    });
    const expiredBytes = new TextEncoder().encode(JSON.stringify(envelope));
    const expired = await signInternalRequest(
      secret,
      "POST",
      pathname,
      expiredBytes,
      Math.floor(Date.now() / 1_000) - 301,
    );
    const missing = new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: unreadableBody(),
      duplex: "half",
    } as RequestInit);
    const expiredRequest = new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sgeo-timestamp": expired.timestamp,
        "x-sgeo-signature": expired.signature,
      },
      body: unreadableBody(),
      duplex: "half",
    } as RequestInit);

    await expect(post(missing)).resolves.toMatchObject({ status: 401 });
    await expect(post(expiredRequest)).resolves.toMatchObject({ status: 401 });
    expect(created.ingest).not.toHaveBeenCalled();
  });

  it("rejects oversized declared JSON bodies before consuming them", async () => {
    const created = service();
    const post = createAnalysisIngestRoute(() => created);
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    const signed = await signInternalRequest(secret, "POST", pathname, bytes);
    let cancellations = 0;
    const request = new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(1_048_577),
        "x-sgeo-timestamp": signed.timestamp,
        "x-sgeo-signature": signed.signature,
      },
      body: new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {});
        },
        cancel() {
          cancellations += 1;
        },
      }),
      duplex: "half",
    } as RequestInit);

    const response = await post(request);

    expect(response.status).toBe(413);
    expect(cancellations).toBe(1);
    expect(created.ingest).not.toHaveBeenCalled();
  });

  it("accepts a legal leading-zero Content-Length", async () => {
    const created = service();
    const post = createAnalysisIngestRoute(() => created);
    const rawBody = JSON.stringify(envelope);
    const byteSize = new TextEncoder().encode(rawBody).byteLength;

    const response = await post(await signedRequest(
      rawBody,
      Math.floor(Date.now() / 1_000),
      "application/json",
      "POST",
      { "content-length": `000${byteSize}` },
    ));

    expect(response.status).toBe(202);
    expect(created.ingest).toHaveBeenCalledWith(envelope);
  });

  it.each(["+1", "-1", " 1", "1 ", "1.0", "1e3"])(
    "rejects non-decimal Content-Length %j",
    async (declaredLength) => {
      const created = service();
      const post = createAnalysisIngestRoute(() => created);
      const request = await signedRequest(JSON.stringify(envelope));
      const headers = request.headers;
      Object.defineProperty(request, "headers", {
        value: {
          get: (name: string) => name.toLowerCase() === "content-length"
            ? declaredLength
            : headers.get(name),
        },
      });

      const response = await post(request);

      expect(response.status).toBe(400);
      expect(created.ingest).not.toHaveBeenCalled();
    },
  );

  it("rejects chunked JSON bodies that exceed the configured byte cap", async () => {
    const created = service();
    const post = createAnalysisIngestRoute(() => created, 3);
    const bytes = new TextEncoder().encode("1234");

    const response = await post(await signedRequest(
      "1234",
      Math.floor(Date.now() / 1_000),
      "application/json",
      "POST",
      {},
      [bytes.subarray(0, 2), bytes.subarray(2)],
    ));

    expect(response.status).toBe(413);
    expect(created.ingest).not.toHaveBeenCalled();
  });

  it("maps a signed request stream failure to a safe bad request", async () => {
    const created = service();
    const post = createAnalysisIngestRoute(() => created);
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    const signed = await signInternalRequest(secret, "POST", pathname, bytes);
    const request = new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sgeo-timestamp": signed.timestamp,
        "x-sgeo-signature": signed.signature,
      },
      body: new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("stream failed");
        },
      }),
      duplex: "half",
    } as RequestInit);

    const response = await post(request);

    expect(response.status).toBe(400);
    expect(created.ingest).not.toHaveBeenCalled();
  });

  it("rejects an expired signature before parsing the envelope", async () => {
    const created = service();
    const post = createAnalysisIngestRoute(() => created);

    const response = await post(await signedRequest(
      JSON.stringify(envelope),
      Math.floor(Date.now() / 1_000) - 301,
    ));

    expect(response.status).toBe(401);
    expect(created.ingest).not.toHaveBeenCalled();
  });

  it("rejects malformed signed JSON with a safe client error", async () => {
    const created = service();
    const post = createAnalysisIngestRoute(() => created);

    const response = await post(await signedRequest("{not-json"));

    expect(response.status).toBe(400);
    expect(created.ingest).not.toHaveBeenCalled();
  });

  it("passes a signed envelope to the service and returns its replay state", async () => {
    const created = service();
    created.ingest.mockResolvedValueOnce({
      runId: "run_1",
      status: "accepted",
      duplicate: true,
    });
    const post = createAnalysisIngestRoute(() => created);
    const rawBody = JSON.stringify(envelope);

    const response = await post(await signedRequest(rawBody));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      runId: "run_1",
      status: "accepted",
      duplicate: true,
    });
    expect(created.ingest).toHaveBeenCalledWith(envelope);
  });

  it("maps ownership failures to a non-enumerating not-found response", async () => {
    const created = service();
    created.ingest.mockRejectedValueOnce(new AnalysisIngestError(
      "RUN_OWNERSHIP_MISMATCH",
    ));
    const post = createAnalysisIngestRoute(() => created);

    const response = await post(await signedRequest(JSON.stringify(envelope)));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Analysis run not found",
      code: "RUN_NOT_FOUND",
    });
  });

  it("maps a changed artifact checksum to conflict", async () => {
    const created = service();
    created.ingest.mockRejectedValueOnce(new AnalysisIngestError(
      "RUN_CHECKSUM_CONFLICT",
    ));
    const post = createAnalysisIngestRoute(() => created);

    const response = await post(await signedRequest(JSON.stringify(envelope)));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Analysis artifact conflicts with the accepted run",
      code: "RUN_CHECKSUM_CONFLICT",
    });
  });

  it("maps unavailable artifact storage to a safe retryable response", async () => {
    const created = service();
    created.ingest.mockRejectedValueOnce(new AnalysisIngestError(
      "ARTIFACT_UNAVAILABLE",
    ));
    const post = createAnalysisIngestRoute(() => created);

    const response = await post(await signedRequest(JSON.stringify(envelope)));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Artifact storage is temporarily unavailable",
      code: "ARTIFACT_UNAVAILABLE",
    });
  });

  it("fails safely when default artifact storage cannot be constructed", async () => {
    delete process.env.SGEO_ARTIFACT_ROOT;
    const post = createAnalysisIngestRoute();

    const response = await post(await signedRequest(JSON.stringify(envelope)));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Artifact storage is temporarily unavailable",
      code: "ARTIFACT_UNAVAILABLE",
    });
  });

  it("rejects an unsupported signed content type", async () => {
    const created = service();
    const post = createAnalysisIngestRoute(() => created);

    const response = await post(await signedRequest(
      JSON.stringify(envelope),
      Math.floor(Date.now() / 1_000),
      "text/plain",
    ));

    expect(response.status).toBe(415);
    expect(created.ingest).not.toHaveBeenCalled();
  });
});
