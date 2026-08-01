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
import { prepareSignedInternalRequest } from "@/lib/internal-auth";

const checksumPattern = /^sha256:[a-f0-9]{64}$/;
export const maximumAnalysisArtifactBytes = 64 * 1024 * 1024;
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
    case "ARTIFACT_TOO_LARGE":
      return jsonError(413, "Artifact body exceeds the byte limit", "ARTIFACT_TOO_LARGE");
    case "ARTIFACT_CONFLICT":
      return jsonError(409, "Artifact already exists with different content", "ARTIFACT_CONFLICT");
    case "ARTIFACT_UNAVAILABLE":
    case "ARTIFACT_ROOT_REQUIRED":
    case "ARTIFACT_ROOT_INVALID":
    case "ARTIFACT_PUBLISH_UNAVAILABLE":
    case "ARTIFACT_PUBLISH_FAILED":
      return jsonError(
        503,
        "Artifact storage is temporarily unavailable",
        "ARTIFACT_UNAVAILABLE",
      );
    default:
      return jsonError(500, "Internal server error", "INTERNAL_ERROR");
  }
}

export function createAnalysisArtifactRoute(
  buildStore: () => ArtifactStore = createDefaultStore,
  maximumByteSize = maximumAnalysisArtifactBytes,
) {
  return async function POST(request: Request, context: ArtifactRouteContext) {
    if (request.method !== "POST") {
      return jsonError(405, "Method not allowed", "METHOD_NOT_ALLOWED");
    }
    const signed = await prepareSignedInternalRequest(request);
    if (signed === null) {
      return jsonError(401, "Internal authentication required", "UNAUTHORIZED");
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
    const claimedDigest = checksum.slice("sha256:".length);
    if (!(await signed.verifyBodyDigest(claimedDigest))) {
      return jsonError(401, "Internal authentication required", "UNAUTHORIZED");
    }

    const { id: runId } = await context.params;
    let uri: string;
    try {
      const coordinates = createArtifactCoordinates(runId, name);
      uri = coordinates.uri;
    } catch (error) {
      if (error instanceof ArtifactUriError) {
        return jsonError(400, "Invalid artifact request", "INVALID_ARTIFACT");
      }
      return jsonError(500, "Internal server error", "INTERNAL_ERROR");
    }

    let upload: Awaited<ReturnType<ArtifactStore["beginUpload"]>> | undefined;
    try {
      upload = await buildStore().beginUpload(
        runId,
        name,
        receivedMediaType,
        maximumByteSize,
      );
      const hash = createHash("sha256");
      let byteSize = 0;
      const reader = request.body?.getReader();
      if (reader !== undefined) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array)) {
              throw new ArtifactStoreError(
                "ARTIFACT_INPUT_INVALID",
                "Artifact request body is invalid.",
              );
            }
            if (value.byteLength > maximumByteSize - byteSize) {
              throw new ArtifactStoreError(
                "ARTIFACT_TOO_LARGE",
                "Artifact body exceeds the configured byte limit.",
              );
            }
            await upload.write(value);
            hash.update(value);
            byteSize += value.byteLength;
          }
        } finally {
          reader.releaseLock();
        }
      }
      const bodyDigest = hash.digest("hex");
      const actualChecksum = `sha256:${bodyDigest}`;
      if (checksum !== actualChecksum) {
        await upload.abort();
        upload = undefined;
        return jsonError(422, "Artifact checksum does not match request bytes", "CHECKSUM_MISMATCH");
      }
      if (!(await signed.verifyBodyDigest(bodyDigest))) {
        await upload.abort();
        upload = undefined;
        return jsonError(401, "Internal authentication required", "UNAUTHORIZED");
      }
      const expected: StoredArtifact = {
        uri,
        checksum,
        mediaType: receivedMediaType,
        byteSize,
      };
      const stored = await upload.commit(expected);
      upload = undefined;
      if (!matchesStoredArtifact(stored, expected)) {
        return jsonError(500, "Internal server error", "INTERNAL_ERROR");
      }
      return NextResponse.json(expected, { status: 201 });
    } catch (error) {
      if (upload !== undefined) {
        try {
          await upload.abort();
        } catch {
          // The original storage error remains the safe route response.
        }
      }
      return storeError(error);
    }
  };
}

export const POST = createAnalysisArtifactRoute();
