import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import {
  ArtifactStoreError,
  LocalArtifactStore,
} from "@/lib/artifacts/local-store";
import type { ArtifactStore, StoredArtifact } from "@/lib/artifacts/store";
import {
  ArtifactUriError,
  createArtifactCoordinates,
} from "@/lib/artifacts/uri";
import { verifySignedInternalRequest } from "@/lib/internal-auth";

const checksumPattern = /^sha256:[a-f0-9]{64}$/;
const supportedMediaTypes = new Set([
  "application/octet-stream",
  "application/json",
]);

type ArtifactRouteContext = {
  params: Promise<{ id: string }>;
};

function createDefaultStore(): ArtifactStore {
  return new LocalArtifactStore();
}

function jsonError(status: number, error: string, code: string) {
  return NextResponse.json({ error, code }, { status });
}

function mediaType(request: Request) {
  const received = request.headers.get("content-type")?.split(";", 1)[0]
    ?.trim().toLowerCase();
  return received !== undefined && supportedMediaTypes.has(received)
    ? received
    : null;
}

function bodyChecksum(body: Uint8Array) {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function matchesStoredArtifact(
  stored: StoredArtifact,
  expected: StoredArtifact,
) {
  return stored.uri === expected.uri &&
    stored.checksum === expected.checksum &&
    stored.mediaType === expected.mediaType &&
    stored.byteSize === expected.byteSize;
}

function storeError(error: unknown): NextResponse {
  if (!(error instanceof ArtifactStoreError)) {
    return jsonError(500, "Internal server error", "INTERNAL_ERROR");
  }
  switch (error.code) {
    case "ARTIFACT_INPUT_INVALID":
    case "ARTIFACT_URI_INVALID":
      return jsonError(400, "Invalid artifact request", "INVALID_ARTIFACT");
    case "ARTIFACT_CONFLICT":
      return jsonError(409, "Artifact already exists with different content", "ARTIFACT_CONFLICT");
    default:
      return jsonError(500, "Internal server error", "INTERNAL_ERROR");
  }
}

export function createAnalysisArtifactRoute(
  buildStore: () => ArtifactStore = createDefaultStore,
) {
  return async function POST(request: Request, context: ArtifactRouteContext) {
    const rawBody = new Uint8Array(await request.arrayBuffer());
    if (!(await verifySignedInternalRequest(request, rawBody))) {
      return jsonError(401, "Internal authentication required", "UNAUTHORIZED");
    }
    if (request.method !== "POST") {
      return jsonError(405, "Method not allowed", "METHOD_NOT_ALLOWED");
    }

    const receivedMediaType = mediaType(request);
    if (receivedMediaType === null) {
      return jsonError(415, "Unsupported media type", "UNSUPPORTED_MEDIA_TYPE");
    }
    const name = request.headers.get("x-sgeo-artifact-name");
    const checksum = request.headers.get("x-sgeo-artifact-sha256");
    if (!name || !checksum || !checksumPattern.test(checksum)) {
      return jsonError(400, "Invalid artifact request", "INVALID_ARTIFACT");
    }
    if (checksum !== bodyChecksum(rawBody)) {
      return jsonError(422, "Artifact checksum does not match request bytes", "CHECKSUM_MISMATCH");
    }

    const { id: runId } = await context.params;
    let expected: StoredArtifact;
    try {
      const coordinates = createArtifactCoordinates(runId, name);
      expected = {
        uri: coordinates.uri,
        checksum,
        mediaType: receivedMediaType,
        byteSize: rawBody.byteLength,
      };
    } catch (error) {
      if (error instanceof ArtifactUriError) {
        return jsonError(400, "Invalid artifact request", "INVALID_ARTIFACT");
      }
      return jsonError(500, "Internal server error", "INTERNAL_ERROR");
    }

    try {
      const stored = await buildStore().put(
        runId,
        name,
        rawBody,
        receivedMediaType,
      );
      if (!matchesStoredArtifact(stored, expected)) {
        return jsonError(500, "Internal server error", "INTERNAL_ERROR");
      }
      return NextResponse.json(expected, { status: 201 });
    } catch (error) {
      return storeError(error);
    }
  };
}

export const POST = createAnalysisArtifactRoute();
