import { NextResponse } from "next/server";

import { analysisEnvelopeSchema } from "@sgeo/analysis-contract";
import {
  AnalysisIngestError,
  AnalysisIngestService,
} from "@/lib/analysis/ingest-service";
import { PrismaAnalysisRepository } from "@/lib/analysis/repository";
import { LocalArtifactStore } from "@/lib/artifacts/local-store";
import { verifySignedInternalRequest } from "@/lib/internal-auth";

type IngestService = Pick<AnalysisIngestService, "ingest">;

function createDefaultService(): IngestService {
  return new AnalysisIngestService(
    new PrismaAnalysisRepository(),
    new LocalArtifactStore(),
  );
}

function jsonError(status: number, error: string, code: string) {
  return NextResponse.json({ error, code }, { status });
}

function isJsonContentType(request: Request) {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim()
    .toLowerCase() === "application/json";
}

function routeError(error: unknown): NextResponse {
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
      return jsonError(500, "Internal server error", "INTERNAL_ERROR");
  }
}

export function createAnalysisIngestRoute(
  buildService: () => IngestService = createDefaultService,
) {
  return async function POST(request: Request) {
    const rawBody = new Uint8Array(await request.arrayBuffer());
    if (!(await verifySignedInternalRequest(request, rawBody))) {
      return jsonError(401, "Internal authentication required", "UNAUTHORIZED");
    }
    if (request.method !== "POST") {
      return jsonError(405, "Method not allowed", "METHOD_NOT_ALLOWED");
    }
    if (!isJsonContentType(request)) {
      return jsonError(415, "Unsupported media type", "UNSUPPORTED_MEDIA_TYPE");
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
