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

export type SearchConsoleControlScope = {
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
  integrationId: string;
  property: string;
};

const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;

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

function exactRecord(value: unknown, keys: readonly string[]) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join("\u0000") === [...keys].sort().join("\u0000")
    ? record
    : null;
}

async function boundedJsonResponse(response: Response) {
  const invalidResponse = () => new SgeoOpsClientError(
    "SGeoOps returned an invalid control response.",
    { retryable: false },
  );
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_CONTROL_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw invalidResponse();
  }

  const reader = response.body?.getReader();
  if (reader === undefined) throw invalidResponse();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > MAX_CONTROL_RESPONSE_BYTES - size) {
        throw invalidResponse();
      }
      chunks.push(value);
      size += value.byteLength;
    }
    complete = true;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(raw) as unknown;
  } catch {
    throw invalidResponse();
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Preserve the bounded control-response error.
    }
  }
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

  async getSearchConsoleCredential(
    runId: string,
    scope: SearchConsoleControlScope,
  ): Promise<{ token: string }> {
    const pathname = `/api/internal/analysis-runs/${encodeURIComponent(runId)}/search-console/credential`;
    const body = JSON.stringify(scope);
    const response = await this.signedPost(pathname, body, {
      "content-type": "application/json",
    });
    const payload = exactRecord(await boundedJsonResponse(response), ["token"]);
    const token = payload?.token;
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      Buffer.byteLength(token, "utf8") > MAX_CONTROL_RESPONSE_BYTES ||
      /[\u0000-\u001f\u007f]/.test(token)
    ) {
      throw new SgeoOpsClientError("SGeoOps returned an invalid credential response.", {
        retryable: false,
      });
    }
    return { token };
  }

  async reportSearchConsoleAuthenticationFailure(
    runId: string,
    scope: SearchConsoleControlScope,
  ): Promise<{ disabled: true; recommendationId: string }> {
    const pathname = `/api/internal/analysis-runs/${encodeURIComponent(runId)}/search-console/auth-failure`;
    const body = JSON.stringify(scope);
    const response = await this.signedPost(pathname, body, {
      "content-type": "application/json",
    });
    const payload = exactRecord(await boundedJsonResponse(response), ["disabled", "recommendationId"]);
    if (
      payload?.disabled !== true ||
      typeof payload.recommendationId !== "string" ||
      payload.recommendationId.length === 0 ||
      payload.recommendationId.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(payload.recommendationId)
    ) {
      throw new SgeoOpsClientError("SGeoOps returned an invalid authentication-failure response.", {
        retryable: false,
      });
    }
    return { disabled: true, recommendationId: payload.recommendationId };
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
