import { createHash } from "node:crypto";

import {
  analysisEnvelopeSchema,
  type AnalysisEnvelope,
} from "@sgeo/analysis-contract";
import { signInternalRequest } from "@sgeo/internal-protocol";

type SgeoOpsFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type ArtifactMetadata = NonNullable<AnalysisEnvelope["rawArtifact"]>;

export class SgeoOpsClientError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    options: { retryable: boolean; status?: number },
  ) {
    super(message);
    this.name = "SgeoOpsClientError";
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export type SgeoOpsClientOptions = {
  baseUrl: string;
  secret: string;
  fetch?: SgeoOpsFetch;
};

function parseArtifactMetadata(value: unknown): ArtifactMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SgeoOpsClientError("SGeoOps returned invalid artifact metadata.", {
      retryable: false,
    });
  }

  const metadata = value as Record<string, unknown>;
  if (
    typeof metadata.uri !== "string" ||
    !metadata.uri.startsWith("artifact://") ||
    typeof metadata.checksum !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(metadata.checksum) ||
    typeof metadata.mediaType !== "string" ||
    metadata.mediaType.length === 0 ||
    typeof metadata.byteSize !== "number" ||
    !Number.isInteger(metadata.byteSize) ||
    metadata.byteSize < 0
  ) {
    throw new SgeoOpsClientError("SGeoOps returned invalid artifact metadata.", {
      retryable: false,
    });
  }

  return {
    uri: metadata.uri,
    checksum: metadata.checksum,
    mediaType: metadata.mediaType,
    byteSize: metadata.byteSize,
  };
}

function validateUploadedArtifact(
  metadata: ArtifactMetadata,
  expected: Omit<ArtifactMetadata, "uri">,
): ArtifactMetadata {
  if (
    metadata.checksum !== expected.checksum ||
    metadata.mediaType !== expected.mediaType ||
    metadata.byteSize !== expected.byteSize
  ) {
    throw new SgeoOpsClientError(
      "SGeoOps returned artifact metadata that does not match the uploaded bytes.",
      { retryable: false },
    );
  }

  return metadata;
}

function requestError(status: number) {
  return new SgeoOpsClientError(
    `SGeoOps request failed with status ${status}.`,
    {
      status,
      retryable: status === 429 || status >= 500,
    },
  );
}

export class SgeoOpsClient {
  private readonly baseUrl: string;
  private readonly fetch: SgeoOpsFetch;
  private readonly secret: string;

  constructor(options: SgeoOpsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.secret = options.secret;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async ingest(envelope: AnalysisEnvelope): Promise<void> {
    const body = JSON.stringify(analysisEnvelopeSchema.parse(envelope));
    await this.signedPost("/api/internal/analysis-runs/ingest", body, {
      "content-type": "application/json",
    });
  }

  async uploadArtifact(
    runId: string,
    name: string,
    body: Uint8Array,
    mediaType: string,
  ): Promise<ArtifactMetadata> {
    const pathname = `/api/internal/analysis-runs/${encodeURIComponent(runId)}/artifacts`;
    const checksum = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const response = await this.signedPost(pathname, body, {
      "content-type": mediaType,
      "x-sgeo-artifact-name": name,
      "x-sgeo-artifact-sha256": checksum,
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SgeoOpsClientError(
        "SGeoOps returned an invalid artifact response.",
        { retryable: false },
      );
    }

    return validateUploadedArtifact(parseArtifactMetadata(payload), {
      checksum,
      mediaType,
      byteSize: body.byteLength,
    });
  }

  private async signedPost(
    pathname: string,
    body: string | Uint8Array,
    headers: HeadersInit,
  ): Promise<Response> {
    const signature = await signInternalRequest(
      this.secret,
      "POST",
      pathname,
      body,
    );
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          ...headers,
          "x-sgeo-timestamp": signature.timestamp,
          "x-sgeo-signature": signature.signature,
        },
        body: body as unknown as BodyInit,
      });
    } catch {
      throw new SgeoOpsClientError("SGeoOps request could not be completed.", {
        retryable: true,
      });
    }

    if (!response.ok) {
      throw requestError(response.status);
    }

    return response;
  }
}
