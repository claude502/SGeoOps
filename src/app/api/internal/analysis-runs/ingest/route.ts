import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { analysisEnvelopeSchema } from "@sgeo/analysis-contract";
import {
  AnalysisIngestError,
  AnalysisIngestService,
} from "@/lib/analysis/ingest-service";
import { PrismaAnalysisRepository } from "@/lib/analysis/repository";
import {
  ArtifactStoreError,
  LocalArtifactStore,
} from "@/lib/artifacts/local-store";
import { prepareSignedInternalRequest } from "@/lib/internal-auth";

type IngestService = Pick<AnalysisIngestService, "ingest">;
/** Analysis envelopes are compact versioned JSON; artifacts use their own route. */
export const maximumAnalysisEnvelopeBytes = 1_024 * 1_024;

class AnalysisBodyError extends Error {
  constructor(readonly code: "INVALID" | "TOO_LARGE") {
    super(code);
    this.name = "AnalysisBodyError";
  }
}

function createDefaultService(): IngestService {
  const artifacts = new LocalArtifactStore();
  return new AnalysisIngestService(
    new PrismaAnalysisRepository(),
    artifacts,
  );
}

function jsonError(status: number, error: string, code: string) {
  return NextResponse.json({ error, code }, { status });
}

function isJsonContentType(request: Request) {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim()
    .toLowerCase() === "application/json";
}

function contentLength(request: Request): number | null {
  const received = request.headers.get("content-length");
  if (received === null) return null;
  if (!/^\d+$/.test(received)) {
    throw new AnalysisBodyError("INVALID");
  }
  const parsed = Number(received);
  if (!Number.isSafeInteger(parsed)) {
    throw new AnalysisBodyError("INVALID");
  }
  return parsed;
}

async function cancelRequestBody(request: Request) {
  try {
    await request.body?.cancel();
  } catch {
    // The early size response must not be replaced by a stream cleanup error.
  }
}

async function readBoundedJsonBody(request: Request, maximumByteSize: number) {
  const reader = request.body?.getReader();
  if (reader === undefined) {
    return { bytes: new Uint8Array(), digest: createHash("sha256").digest("hex") };
  }

  const chunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let byteSize = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new AnalysisBodyError("INVALID");
      }
      if (value.byteLength > maximumByteSize - byteSize) {
        throw new AnalysisBodyError("TOO_LARGE");
      }
      chunks.push(value);
      hash.update(value);
      byteSize += value.byteLength;
    }
    completed = true;
    const bytes = new Uint8Array(byteSize);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, digest: hash.digest("hex") };
  } catch (error) {
    if (error instanceof AnalysisBodyError) throw error;
    throw new AnalysisBodyError("INVALID");
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The primary bounded-read failure controls the safe route response.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // A reader cleanup error must not escape the internal route boundary.
    }
  }
}

function artifactUnavailable() {
  return jsonError(
    503,
    "Artifact storage is temporarily unavailable",
    "ARTIFACT_UNAVAILABLE",
  );
}

function routeError(error: unknown): NextResponse {
  if (error instanceof ArtifactStoreError) {
    return artifactUnavailable();
  }
  if (!(error instanceof AnalysisIngestError)) {
    return jsonError(500, "Internal server error", "INTERNAL_ERROR");
  }

  switch (error.code) {
    case "RUN_NOT_FOUND":
    case "RUN_OWNERSHIP_MISMATCH":
      return jsonError(404, "Analysis run not found", "RUN_NOT_FOUND");
    case "RUN_ARTIFACT_MISSING":
      return jsonError(
        409,
        "Referenced analysis artifact has not been uploaded",
        "RUN_ARTIFACT_MISSING",
      );
    case "RUN_CHECKSUM_CONFLICT":
      return jsonError(
        409,
        "Analysis artifact conflicts with the accepted run",
        "RUN_CHECKSUM_CONFLICT",
      );
    case "RUN_CONTRACT_MISMATCH":
      return jsonError(
        409,
        "Analysis run contract conflicts with the accepted run",
        "RUN_CONTRACT_MISMATCH",
      );
    case "RUN_REPLAY_CONFLICT":
      return jsonError(
        409,
        "Analysis payload conflicts with the accepted run",
        "RUN_REPLAY_CONFLICT",
      );
    case "ARTIFACT_UNAVAILABLE":
      return artifactUnavailable();
  }
}

export function createAnalysisIngestRoute(
  buildService: () => IngestService = createDefaultService,
  maximumByteSize = maximumAnalysisEnvelopeBytes,
) {
  return async function POST(request: Request) {
    if (request.method !== "POST") {
      return jsonError(405, "Method not allowed", "METHOD_NOT_ALLOWED");
    }
    const signed = await prepareSignedInternalRequest(request);
    if (signed === null) {
      return jsonError(401, "Internal authentication required", "UNAUTHORIZED");
    }
    if (!isJsonContentType(request)) {
      return jsonError(415, "Unsupported media type", "UNSUPPORTED_MEDIA_TYPE");
    }

    let rawBody: Uint8Array;
    let bodyDigest: string;
    try {
      const declaredLength = contentLength(request);
      if (declaredLength !== null && declaredLength > maximumByteSize) {
        await cancelRequestBody(request);
        return jsonError(413, "Analysis envelope exceeds the byte limit", "ENVELOPE_TOO_LARGE");
      }
      ({ bytes: rawBody, digest: bodyDigest } = await readBoundedJsonBody(
        request,
        maximumByteSize,
      ));
    } catch (error) {
      if (error instanceof AnalysisBodyError) {
        return error.code === "TOO_LARGE"
          ? jsonError(413, "Analysis envelope exceeds the byte limit", "ENVELOPE_TOO_LARGE")
          : jsonError(400, "Invalid analysis envelope", "INVALID_ENVELOPE");
      }
      return jsonError(400, "Invalid analysis envelope", "INVALID_ENVELOPE");
    }
    if (!(await signed.verifyBodyDigest(bodyDigest))) {
      return jsonError(401, "Internal authentication required", "UNAUTHORIZED");
    }

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
    } catch {
      return jsonError(400, "Invalid analysis envelope", "INVALID_ENVELOPE");
    }
    const parsed = analysisEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(400, "Invalid analysis envelope", "INVALID_ENVELOPE");
    }

    try {
      const result = await buildService().ingest(parsed.data);
      return NextResponse.json(result, { status: 202 });
    } catch (error) {
      return routeError(error);
    }
  };
}

export const POST = createAnalysisIngestRoute();
