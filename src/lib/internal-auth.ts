import { readFile } from "node:fs/promises";

export {
  signInternalRequest,
  verifyInternalRequest,
  type InternalRequestBody,
  type InternalSignature,
} from "@sgeo/internal-protocol";

import { verifyInternalRequest } from "@sgeo/internal-protocol";

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
