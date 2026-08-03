import { readFile } from "node:fs/promises";

type InternalSgeoEnvironment = Record<string, string | undefined>;

export class InternalSgeoAuthError extends Error {
  readonly code: "secret_missing" | "secret_file_unreadable" | "secret_file_empty" | "secret_empty";

  constructor(
    code: "secret_missing" | "secret_file_unreadable" | "secret_file_empty" | "secret_empty",
  ) {
    super(messageFor(code));
    this.name = "InternalSgeoAuthError";
    this.code = code;
  }
}

function messageFor(code: InternalSgeoAuthError["code"]) {
  switch (code) {
    case "secret_file_unreadable":
      return "SGEO_INTERNAL_SECRET_FILE could not be read.";
    case "secret_file_empty":
      return "SGEO_INTERNAL_SECRET_FILE must contain a secret.";
    case "secret_empty":
      return "SGEO_INTERNAL_SECRET must contain a secret.";
    case "secret_missing":
      return "SGEO_INTERNAL_SECRET_FILE or SGEO_INTERNAL_SECRET is required.";
  }
}

export async function readInternalSgeoSecret(
  environment: InternalSgeoEnvironment = process.env,
) {
  const configuredFile = environment.SGEO_INTERNAL_SECRET_FILE;
  if (configuredFile !== undefined) {
    const secretFile = configuredFile.trim();
    if (secretFile.length === 0) throw new InternalSgeoAuthError("secret_file_empty");

    let secret: string;
    try {
      secret = (await readFile(secretFile, "utf8")).trim();
    } catch {
      throw new InternalSgeoAuthError("secret_file_unreadable");
    }
    if (secret.length === 0) throw new InternalSgeoAuthError("secret_file_empty");
    return secret;
  }

  const configuredSecret = environment.SGEO_INTERNAL_SECRET;
  if (configuredSecret === undefined) throw new InternalSgeoAuthError("secret_missing");

  const secret = configuredSecret.trim();
  if (secret.length === 0) throw new InternalSgeoAuthError("secret_empty");
  return secret;
}
