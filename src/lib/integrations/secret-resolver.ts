import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export type SecretRef = `file:${string}`;

export interface SecretResolver {
  resolve(reference: SecretRef): Promise<string>;
}

type SecretEnvironment = Readonly<Record<string, string | undefined>>;
type FileIdentity = { dev: bigint; ino: bigint };
type TrustedRoot = {
  inputPath: string;
  canonicalPath: string;
  identity: FileIdentity;
};
type TrustedTarget = {
  canonicalPath: string;
  identity: FileIdentity;
};

class SecretResolutionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SecretResolutionError";
  }
}

function secretError(code: string): SecretResolutionError {
  return new SecretResolutionError(code);
}

function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev && left.ino === right.ino;
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

  return { relativePath, segments };
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

async function loadTrustedRoot(configuredRoot: string): Promise<TrustedRoot> {
  const inputPath = resolve(configuredRoot);
  try {
    const inputStat = await lstat(inputPath, { bigint: true });
    if (inputStat.isSymbolicLink() || !inputStat.isDirectory()) {
      throw secretError("SGEO_SECRET_ROOT_INVALID");
    }
    const canonicalPath = await realpath(inputPath);
    const canonicalStat = await stat(canonicalPath, { bigint: true });
    if (!canonicalStat.isDirectory()) {
      throw secretError("SGEO_SECRET_ROOT_INVALID");
    }
    return {
      inputPath,
      canonicalPath,
      identity: canonicalStat,
    };
  } catch (error) {
    if (error instanceof SecretResolutionError) {
      throw error;
    }
    throw secretError("SGEO_SECRET_ROOT_INVALID");
  }
}

async function validateNoSymlinkComponents(
  root: string,
  segments: readonly string[],
  changedCode?: string,
) {
  let current = root;
  try {
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const entry = await lstat(current, { bigint: true });
      if (entry.isSymbolicLink()) {
        throw secretError(changedCode ?? "SECRET_SYMLINK_FORBIDDEN");
      }
      const isTarget = index === segments.length - 1;
      if ((!isTarget && !entry.isDirectory()) || (isTarget && !entry.isFile())) {
        throw secretError(
          changedCode ??
            (isTarget ? "SECRET_NOT_REGULAR_FILE" : "SECRET_NOT_FOUND"),
        );
      }
    }
  } catch (error) {
    if (error instanceof SecretResolutionError) {
      throw error;
    }
    throw secretError(changedCode ?? "SECRET_NOT_FOUND");
  }
}

async function loadTrustedTarget(
  root: TrustedRoot,
  relativePath: string,
  segments: readonly string[],
): Promise<TrustedTarget> {
  const candidate = resolve(root.canonicalPath, relativePath);
  if (!isInsideRoot(root.canonicalPath, candidate)) {
    throw secretError("SECRET_OUTSIDE_ROOT");
  }

  await validateNoSymlinkComponents(root.canonicalPath, segments);

  try {
    const canonicalPath = await realpath(candidate);
    if (!isInsideRoot(root.canonicalPath, canonicalPath)) {
      throw secretError("SECRET_OUTSIDE_ROOT");
    }
    const targetStat = await stat(canonicalPath, { bigint: true });
    if (!targetStat.isFile()) {
      throw secretError("SECRET_NOT_REGULAR_FILE");
    }
    return {
      canonicalPath,
      identity: targetStat,
    };
  } catch (error) {
    if (error instanceof SecretResolutionError) {
      throw error;
    }
    throw secretError("SECRET_NOT_FOUND");
  }
}

async function validateTrustedSnapshot(
  root: TrustedRoot,
  target: TrustedTarget,
  relativePath: string,
  segments: readonly string[],
  handle: FileHandle,
) {
  try {
    const inputStat = await lstat(root.inputPath, { bigint: true });
    if (inputStat.isSymbolicLink() || !inputStat.isDirectory()) {
      throw secretError("SECRET_IDENTITY_CHANGED");
    }
    const currentRoot = await realpath(root.inputPath);
    const currentRootStat = await stat(currentRoot, { bigint: true });
    if (
      currentRoot !== root.canonicalPath ||
      !sameIdentity(currentRootStat, root.identity)
    ) {
      throw secretError("SECRET_IDENTITY_CHANGED");
    }

    await validateNoSymlinkComponents(
      root.canonicalPath,
      segments,
      "SECRET_IDENTITY_CHANGED",
    );
    const candidate = resolve(root.canonicalPath, relativePath);
    const currentTarget = await realpath(candidate);
    if (
      currentTarget !== target.canonicalPath ||
      !isInsideRoot(root.canonicalPath, currentTarget)
    ) {
      throw secretError("SECRET_IDENTITY_CHANGED");
    }

    const [currentTargetStat, handleStat] = await Promise.all([
      stat(currentTarget, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
    if (
      !currentTargetStat.isFile() ||
      !handleStat.isFile() ||
      !sameIdentity(currentTargetStat, target.identity) ||
      !sameIdentity(handleStat, target.identity)
    ) {
      throw secretError("SECRET_IDENTITY_CHANGED");
    }
  } catch (error) {
    if (error instanceof SecretResolutionError) {
      throw error;
    }
    throw secretError("SECRET_IDENTITY_CHANGED");
  }
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

    const { relativePath, segments } = parseReference(reference);
    const root = await loadTrustedRoot(configuredRoot);
    const target = await loadTrustedTarget(root, relativePath, segments);

    let handle: FileHandle;
    try {
      handle = await open(
        target.canonicalPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch {
      throw secretError("SECRET_NOT_FOUND");
    }

    try {
      const openedStat = await handle.stat({ bigint: true });
      if (
        !openedStat.isFile() ||
        !sameIdentity(openedStat, target.identity)
      ) {
        throw secretError("SECRET_IDENTITY_CHANGED");
      }

      await validateTrustedSnapshot(
        root,
        target,
        relativePath,
        segments,
        handle,
      );
      const bytes = await handle.readFile();
      await validateTrustedSnapshot(
        root,
        target,
        relativePath,
        segments,
        handle,
      );
      return stripOneTrailingNewline(bytes).toString("utf8");
    } catch (error) {
      if (error instanceof SecretResolutionError) {
        throw error;
      }
      throw secretError("SECRET_READ_FAILED");
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}
