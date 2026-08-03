import { NextResponse } from "next/server";

import {
  ArtifactStoreError,
  LocalArtifactStore,
} from "@/lib/artifacts/local-store";
import type { ArtifactStore, StoredArtifact } from "@/lib/artifacts/store";
import { ArtifactUriError, createArtifactCoordinates } from "@/lib/artifacts/uri";
import { prepareSignedInternalRequest } from "@/lib/internal-auth";
import { readBoundedJsonBody } from "@/lib/matomo/internal-route";

const checksumPattern = /^sha256:[a-f0-9]{64}$/;
const maximumArtifactBytes = 64 * 1024 * 1024;
const supportedMediaTypes = new Set([
  "application/octet-stream",
  "application/json",
  "application/vnd.sgeo.search-console-pages.v1",
  "application/vnd.sgeo.matomo-reports.v1",
]);

type ArtifactRouteContext = { params: Promise<{ id: string; name: string }> };

function createDefaultStore(): ArtifactStore {
  return new LocalArtifactStore();
}

function jsonError(status: number, code: string) {
  return NextResponse.json({ error: "Artifact reconciliation failed", code }, { status });
}

function exactArtifact(value: unknown, uri: string): StoredArtifact | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\u0000") !== "artifact") return null;
  const artifact = record.artifact;
  if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) return null;
  const metadata = artifact as Record<string, unknown>;
  if (
    Object.keys(metadata).sort().join("\u0000") !== "byteSize\u0000checksum\u0000mediaType\u0000uri" ||
    metadata.uri !== uri ||
    typeof metadata.checksum !== "string" ||
    !checksumPattern.test(metadata.checksum) ||
    typeof metadata.mediaType !== "string" ||
    !supportedMediaTypes.has(metadata.mediaType) ||
    typeof metadata.byteSize !== "number" ||
    !Number.isInteger(metadata.byteSize) ||
    metadata.byteSize < 0 ||
    metadata.byteSize > maximumArtifactBytes
  ) {
    return null;
  }
  return {
    uri,
    checksum: metadata.checksum,
    mediaType: metadata.mediaType,
    byteSize: metadata.byteSize,
  };
}

function matchesArtifact(left: StoredArtifact, right: StoredArtifact) {
  return left.uri === right.uri &&
    left.checksum === right.checksum &&
    left.mediaType === right.mediaType &&
    left.byteSize === right.byteSize;
}

export function createAnalysisArtifactReconcileRoute(
  buildStore: () => ArtifactStore = createDefaultStore,
) {
  return async function POST(request: Request, context: ArtifactRouteContext) {
    const prepared = await prepareSignedInternalRequest(request);
    if (prepared === null) {
      await request.body?.cancel().catch(() => undefined);
      return jsonError(401, "UNAUTHORIZED");
    }
    const body = await readBoundedJsonBody(request);
    if (!body.ok) {
      if (body.digest !== undefined && !await prepared.verifyBodyDigest(body.digest)) {
        return jsonError(401, "UNAUTHORIZED");
      }
      return jsonError(body.code === "TOO_LARGE" ? 413 : 400, body.code === "TOO_LARGE"
        ? "CONTROL_BODY_TOO_LARGE"
        : "INVALID_CONTROL_BODY");
    }
    if (!await prepared.verifyBodyDigest(body.digest)) {
      return jsonError(401, "UNAUTHORIZED");
    }

    let uri: string;
    try {
      const { id, name } = await context.params;
      uri = createArtifactCoordinates(id, name).uri;
    } catch (error) {
      return jsonError(error instanceof ArtifactUriError ? 400 : 500, error instanceof ArtifactUriError
        ? "INVALID_ARTIFACT"
        : "INTERNAL_ERROR");
    }
    const expected = exactArtifact(body.body, uri);
    if (expected === null) return jsonError(400, "INVALID_CONTROL_BODY");

    try {
      const stored = await buildStore().getMetadata(uri);
      if (!matchesArtifact(stored, expected)) {
        return jsonError(409, "ARTIFACT_CONFLICT");
      }
      return NextResponse.json({ exists: true });
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === "ARTIFACT_NOT_FOUND") {
        return NextResponse.json({ exists: false });
      }
      if (error instanceof ArtifactStoreError) {
        return jsonError(
          error.code === "ARTIFACT_INPUT_INVALID" || error.code === "ARTIFACT_URI_INVALID" ? 400 : 503,
          error.code === "ARTIFACT_INPUT_INVALID" || error.code === "ARTIFACT_URI_INVALID"
            ? "INVALID_ARTIFACT"
            : "ARTIFACT_UNAVAILABLE",
        );
      }
      return jsonError(500, "INTERNAL_ERROR");
    }
  };
}

export const POST = createAnalysisArtifactReconcileRoute();
