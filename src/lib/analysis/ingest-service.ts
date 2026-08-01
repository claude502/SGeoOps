import {
  analysisEnvelopeSchema,
  type AnalysisEnvelope,
} from "@sgeo/analysis-contract";

import {
  AnalysisRepositoryError,
  type AnalysisRepository,
  type VerifyUploadedArtifact,
} from "@/lib/analysis/repository";
import {
  ArtifactStoreError,
} from "@/lib/artifacts/local-store";
import type { ArtifactStore, StoredArtifact } from "@/lib/artifacts/store";

export type AnalysisIngestErrorCode =
  | "RUN_NOT_FOUND"
  | "RUN_OWNERSHIP_MISMATCH"
  | "RUN_CONTRACT_MISMATCH"
  | "RUN_ARTIFACT_MISSING"
  | "RUN_CHECKSUM_CONFLICT"
  | "RUN_REPLAY_CONFLICT"
  | "ARTIFACT_UNAVAILABLE";

export class AnalysisIngestError extends Error {
  constructor(
    readonly code: AnalysisIngestErrorCode,
    message: string = code,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AnalysisIngestError";
  }
}

export interface AnalysisIngestResult {
  runId: string;
  status: "accepted";
  duplicate: boolean;
}

function assertArtifactMetadata(
  expected: NonNullable<AnalysisEnvelope["rawArtifact"]>,
  stored: StoredArtifact,
) {
  if (
    stored.uri !== expected.uri ||
    stored.checksum !== expected.checksum ||
    stored.mediaType !== expected.mediaType ||
    stored.byteSize !== expected.byteSize
  ) {
    throw new AnalysisIngestError(
      "RUN_CHECKSUM_CONFLICT",
      "Uploaded artifact metadata does not match the analysis envelope.",
    );
  }
}

function mapRepositoryError(error: AnalysisRepositoryError): AnalysisIngestError {
  const codeByRepositoryCode: Record<
    AnalysisRepositoryError["code"],
    AnalysisIngestErrorCode
  > = {
    ANALYSIS_RUN_NOT_FOUND: "RUN_NOT_FOUND",
    ANALYSIS_OWNERSHIP_MISMATCH: "RUN_OWNERSHIP_MISMATCH",
    ANALYSIS_CONTRACT_MISMATCH: "RUN_CONTRACT_MISMATCH",
    ANALYSIS_ARTIFACT_CONFLICT: "RUN_CHECKSUM_CONFLICT",
    ANALYSIS_REPLAY_CONFLICT: "RUN_REPLAY_CONFLICT",
  };
  return new AnalysisIngestError(codeByRepositoryCode[error.code], error.code, {
    cause: error,
  });
}

function mapArtifactStoreError(error: ArtifactStoreError): AnalysisIngestError {
  if (error.code === "ARTIFACT_NOT_FOUND") {
    return new AnalysisIngestError("RUN_ARTIFACT_MISSING", error.code, {
      cause: error,
    });
  }
  return new AnalysisIngestError("ARTIFACT_UNAVAILABLE", error.code, {
    cause: error,
  });
}

export class AnalysisIngestService {
  constructor(
    private readonly repository: AnalysisRepository,
    private readonly artifacts: ArtifactStore,
  ) {}

  async ingest(envelope: AnalysisEnvelope): Promise<AnalysisIngestResult> {
    const parsed = analysisEnvelopeSchema.parse(envelope);
    const verifyUploadedArtifact: VerifyUploadedArtifact = async (artifact) => {
      try {
        const stored = await this.artifacts.getMetadata(artifact.uri);
        assertArtifactMetadata(artifact, stored);
        return stored;
      } catch (error) {
        if (error instanceof AnalysisIngestError) throw error;
        if (error instanceof ArtifactStoreError) {
          throw mapArtifactStoreError(error);
        }
        throw error;
      }
    };

    try {
      const accepted = await this.repository.ingest(parsed, verifyUploadedArtifact);
      return {
        runId: parsed.runId,
        status: "accepted",
        duplicate: accepted.duplicate,
      };
    } catch (error) {
      if (error instanceof AnalysisRepositoryError) {
        throw mapRepositoryError(error);
      }
      throw error;
    }
  }
}
