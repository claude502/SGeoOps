import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactStore } from "@/lib/artifacts/store";
import { createAnalysisArtifactRoute } from "../../app/api/internal/analysis-runs/[id]/artifacts/route";
import { SgeoOpsClient } from "../../../geo-worker/src/clients/sgeo-ops";

const secret = "search-console-artifact-chain-secret";
const runId = "run_search_console_1";
const mediaType = "application/vnd.sgeo.search-console-pages.v1";
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
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, {
      ...init,
      duplex: "half",
    } as RequestInit);
    return post(request, { params: Promise.resolve({ id: runId }) });
  });

  return {
    artifacts,
    upload,
    client: new SgeoOpsClient({
      baseUrl: "http://sgeo.test",
      secret,
      fetch,
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
});

describe("Search Console artifact upload chain", () => {
  it("stores the signed Search Console page bundle with its exact vendor media type", async () => {
    const bytes = new TextEncoder().encode("SGSC\u0000page-one");
    const { artifacts, upload, client } = routeBackedClient();

    await expect(client.uploadArtifact(
      runId,
      "search-console-pages-v1.bin",
      bytes,
      mediaType,
    )).resolves.toMatchObject({ mediaType, byteSize: bytes.byteLength });

    expect(artifacts.beginUpload).toHaveBeenCalledWith(
      runId,
      "search-console-pages-v1.bin",
      mediaType,
      expect.any(Number),
    );
    expect(upload.write).toHaveBeenCalledWith(bytes);
    expect(upload.commit).toHaveBeenCalledWith(expect.objectContaining({
      mediaType,
      byteSize: bytes.byteLength,
    }));
  });

  it("still rejects unsupported media types before artifact storage", async () => {
    const { artifacts, client } = routeBackedClient();

    await expect(client.uploadArtifact(
      runId,
      "unsafe.txt",
      new TextEncoder().encode("unsafe"),
      "text/plain",
    )).rejects.toMatchObject({ status: 415, retryable: false });

    expect(artifacts.beginUpload).not.toHaveBeenCalled();
  });
});
