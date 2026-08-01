import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { AnalysisEnvelope } from "@sgeo/analysis-contract";
import { verifyInternalRequest } from "@sgeo/internal-protocol";
import { describe, expect, it, vi } from "vitest";

import { SgeoOpsClient } from "./sgeo-ops";

const secret = "secret";
const baseUrl = "http://geo-ops:3000";
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
  startedAt: "2026-07-31T01:00:00.000Z",
  finishedAt: "2026-07-31T01:01:00.000Z",
  rawArtifact: null,
  observations: [],
  error: null,
};

function requestHeaders(init: RequestInit) {
  return new Headers(init.headers);
}

describe("SgeoOpsClient", () => {
  it("serializes a validated envelope once before signing and sending it", async () => {
    const expectedBody = JSON.stringify(envelope);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const stringify = vi.spyOn(JSON, "stringify");
    const client = new SgeoOpsClient({ baseUrl, secret, fetch });

    try {
      await client.ingest(envelope);

      const [, init] = fetch.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBe(expectedBody);
      expect(
        stringify.mock.results.filter(({ value }) => value === expectedBody),
      ).toHaveLength(1);
    } finally {
      stringify.mockRestore();
    }
  });

  it("sends a signed analysis envelope without a worker database connection", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const client = new SgeoOpsClient({ baseUrl, secret, fetch });

    await client.ingest(envelope);

    expect(fetch).toHaveBeenCalledWith(
      "http://geo-ops:3000/api/internal/analysis-runs/ingest",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    const body = init.body as string;
    const headers = requestHeaders(init);

    expect(body).toBe(JSON.stringify(envelope));
    await expect(
      verifyInternalRequest(
        secret,
        {
          timestamp: headers.get("x-sgeo-timestamp") ?? "",
          signature: headers.get("x-sgeo-signature") ?? "",
        },
        "POST",
        "/api/internal/analysis-runs/ingest",
        body,
      ),
    ).resolves.toBe(true);

    const source = await readFile(new URL("./sgeo-ops.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(?:Prisma|prisma|DATABASE_URL)\b/);
  });

  it("rejects an invalid envelope before making a network request", async () => {
    const fetch = vi.fn();
    const client = new SgeoOpsClient({ baseUrl, secret, fetch });

    await expect(client.ingest({ ...envelope, runId: "" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uploads signed raw bytes and returns validated artifact metadata", async () => {
    const body = new TextEncoder().encode('{"status":"ok"}');
    const checksum = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        uri: "artifact://run_1/report.json",
        checksum,
        mediaType: "application/json",
        byteSize: body.byteLength,
      }),
    );
    const client = new SgeoOpsClient({ baseUrl, secret, fetch });

    await expect(
      client.uploadArtifact("run_1", "report.json", body, "application/json"),
    ).resolves.toEqual({
      uri: "artifact://run_1/report.json",
      checksum,
      mediaType: "application/json",
      byteSize: body.byteLength,
    });

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    const headers = requestHeaders(init);
    expect(url).toBe(
      "http://geo-ops:3000/api/internal/analysis-runs/run_1/artifacts",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-sgeo-artifact-name")).toBe("report.json");
    expect(headers.get("x-sgeo-artifact-sha256")).toBe(checksum);
    await expect(
      verifyInternalRequest(
        secret,
        {
          timestamp: headers.get("x-sgeo-timestamp") ?? "",
          signature: headers.get("x-sgeo-signature") ?? "",
        },
        "POST",
        "/api/internal/analysis-runs/run_1/artifacts",
        body,
      ),
    ).resolves.toBe(true);
  });

  it("rejects artifact metadata that does not describe the uploaded bytes", async () => {
    const body = new TextEncoder().encode("artifact");
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        uri: "artifact://run_1/report.json",
        checksum: `sha256:${"a".repeat(64)}`,
        mediaType: "application/json",
        byteSize: body.byteLength,
      }),
    );
    const client = new SgeoOpsClient({ baseUrl, secret, fetch });

    await expect(
      client.uploadArtifact("run_1", "report.json", body, "application/json"),
    ).rejects.toMatchObject({
      name: "SgeoOpsClientError",
      retryable: false,
    });
  });

  it.each([
    [429, true],
    [503, true],
    [401, false],
    [403, false],
  ])("classifies a %i SGeoOps response as retryable=%s", async (status, retryable) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    const client = new SgeoOpsClient({ baseUrl, secret, fetch });

    await expect(client.ingest(envelope)).rejects.toMatchObject({
      name: "SgeoOpsClientError",
      status,
      retryable,
    });
  });

  it("classifies a transport failure as retryable", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("network unavailable"));
    const client = new SgeoOpsClient({ baseUrl, secret, fetch });

    await expect(client.ingest(envelope)).rejects.toMatchObject({
      name: "SgeoOpsClientError",
      retryable: true,
    });
  });
});
