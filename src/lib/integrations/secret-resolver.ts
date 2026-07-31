import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type SecretRef = `file:${string}`;

export interface SecretResolver {
  resolve(reference: SecretRef): Promise<string>;
}

type SecretEnvironment = Readonly<Record<string, string | undefined>>;

function secretError(code: string, cause?: unknown) {
  return new Error(code, cause === undefined ? undefined : { cause });
}

function isInsideRoot(root: string, target: string) {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function parseReference(reference: string) {
  if (!reference.startsWith("file:")) {
    throw secretError("SECRET_REFERENCE_INVALID");
  }

  const relativePath = reference.slice("file:".length);
  const segments = relativePath.split("/");
  if (
    relativePath.length === 0 ||
    relativePath.includes("\u0000") ||
    relativePath.includes("\\") ||
    isAbsolute(relativePath) ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw secretError("SECRET_REFERENCE_INVALID");
  }

  return relativePath;
}

function stripOneTrailingNewline(bytes: Buffer) {
  if (
    bytes.length >= 2 &&
    bytes[bytes.length - 2] === 0x0d &&
    bytes[bytes.length - 1] === 0x0a
  ) {
    return bytes.subarray(0, -2);
  }
  if (bytes.length >= 1 && bytes[bytes.length - 1] === 0x0a) {
    return bytes.subarray(0, -1);
  }
  return bytes;
}

export class FileSecretResolver implements SecretResolver {
  constructor(
    private readonly environment: SecretEnvironment = process.env,
  ) {}

  async resolve(reference: SecretRef): Promise<string> {
    const configuredRoot = this.environment.SGEO_SECRET_ROOT?.trim();
    if (!configuredRoot) {
      throw secretError("SGEO_SECRET_ROOT_REQUIRED");
    }

    let root: string;
    try {
      root = await realpath(configuredRoot);
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory()) {
        throw secretError("SGEO_SECRET_ROOT_INVALID");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "SGEO_SECRET_ROOT_INVALID") {
        throw error;
      }
      throw secretError("SGEO_SECRET_ROOT_INVALID", error);
    }

    const relativePath = parseReference(reference);
    const candidate = resolve(root, relativePath);
    if (!isInsideRoot(root, candidate)) {
      throw secretError("SECRET_OUTSIDE_ROOT");
    }

    let resolvedFile: string;
    try {
      resolvedFile = await realpath(candidate);
    } catch (error) {
      throw secretError("SECRET_NOT_FOUND", error);
    }
    if (!isInsideRoot(root, resolvedFile)) {
      throw secretError("SECRET_OUTSIDE_ROOT");
    }

    let handle;
    try {
      handle = await open(resolvedFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw secretError("SECRET_NOT_REGULAR_FILE");
      }
      const bytes = await handle.readFile();
      return stripOneTrailingNewline(bytes).toString("utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "SECRET_NOT_REGULAR_FILE"
      ) {
        throw error;
      }
      throw secretError("SECRET_NOT_FOUND", error);
    } finally {
      await handle?.close();
    }
  }
}
