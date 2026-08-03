import { readFile } from "node:fs/promises";

export {
  isInternalSignatureFresh,
  signInternalRequest,
  verifyInternalRequestDigest,
  verifyInternalRequest,
  type InternalRequestBody,
  type InternalSignature,
} from "@sgeo/internal-protocol";

import {
  isInternalSignatureFresh,
  verifyInternalRequest,
  verifyInternalRequestDigest,
} from "@sgeo/internal-protocol";

async function readInternalSecret(env: NodeJS.ProcessEnv = process.env) {
  const inline = env.SGEO_INTERNAL_SECRET?.trim();
  if (inline) {
    return inline;
  }
  const path = env.SGEO_INTERNAL_SECRET_FILE?.trim();
  if (!path) {
    return null;
  }
  try {
    const secret = (await readFile(path, "utf8")).trim();
    return secret || null;
  } catch {
    return null;
  }
}

export async function readInternalSigningSecret() {
  return readInternalSecret();
}

export type PreparedSignedInternalRequest = {
  verifyBodyDigest(bodyDigest: string): Promise<boolean>;
};

/**
 * Performs only the header checks that do not require reading the request
 * body. Callers that stream a body can verify its final SHA-256 digest once.
 */
export async function prepareSignedInternalRequest(
  request: Request,
): Promise<PreparedSignedInternalRequest | null> {
  const secret = await readInternalSecret();
  const signed = {
    timestamp: request.headers.get("x-sgeo-timestamp") ?? "",
    signature: request.headers.get("x-sgeo-signature") ?? "",
  };
  if (!secret || !isInternalSignatureFresh(signed)) {
    return null;
  }

  const method = request.method;
  const pathname = new URL(request.url).pathname;
  return {
    verifyBodyDigest: (bodyDigest) => verifyInternalRequestDigest(
      secret,
      signed,
      method,
      pathname,
      bodyDigest,
    ),
  };
}

export async function verifySignedInternalRequest(
  request: Request,
  body: string | Uint8Array,
): Promise<boolean> {
  const secret = await readInternalSecret();
  if (!secret) {
    return false;
  }
  return verifyInternalRequest(
    secret,
    {
      timestamp: request.headers.get("x-sgeo-timestamp") ?? "",
      signature: request.headers.get("x-sgeo-signature") ?? "",
    },
    request.method,
    new URL(request.url).pathname,
    body,
  );
}
