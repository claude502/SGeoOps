import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { z } from "zod";

import type { ArtifactStore, StoredArtifact } from "@/lib/artifacts/store";
import {
  ArtifactUriError,
  createArtifactCoordinates,
  parseArtifactUri as parseCanonicalArtifactUri,
  type ArtifactCoordinates,
} from "@/lib/artifacts/uri";

const checksumPattern = /^sha256:[a-f0-9]{64}$/;
const mediaTypePattern =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:"[^"\r\n]*"|[A-Za-z0-9!#$&^_.+-]+))*$/;
const metadataSchema = z.object({
  version: z.literal(1),
  uri: z.string(),
  checksum: z.string().regex(checksumPattern),
  mediaType: z.string(),
  byteSize: z.number().int().nonnegative().max(2_147_483_647),
}).strict();
const metadataLimit = 4 * 1024;
const helperConflictExitCode = 73;
const helperUnavailableExitCode = 78;
const helperErrorLimit = 4 * 1024;
const defaultStaleStagingAgeMs = 24 * 60 * 60 * 1_000;
const stagingNamePattern =
  /^\.artifact-tmp-([1-9][0-9]{0,9})-([0-9]{1,16})-[A-Za-z0-9]{6}$/;

export type ArtifactStoreErrorCode =
  | "ARTIFACT_ROOT_REQUIRED"
  | "ARTIFACT_ROOT_INVALID"
  | "ARTIFACT_INPUT_INVALID"
  | "ARTIFACT_URI_INVALID"
  | "ARTIFACT_PATH_UNSAFE"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_CONFLICT"
  | "ARTIFACT_CORRUPT"
  | "ARTIFACT_PUBLISH_UNAVAILABLE"
  | "ARTIFACT_PUBLISH_FAILED";

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: ArtifactStoreErrorCode,
    message: string = code,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArtifactStoreError";
  }
}

type Identity = {
  device: number;
  inode: number;
};

type DirectorySnapshot = Identity & {
  path: string;
  canonical: string;
};

type RootSnapshot = DirectorySnapshot & {
  configuredPath: string;
};

type FileSnapshot = Identity & {
  path: string;
  canonical: string;
  byteSize: number;
};

export interface LocalArtifactStoreTestHooks {
  afterObjectSnapshot?: () => Promise<void>;
  beforePublishRename?: () => Promise<void>;
  now?: () => number;
  staleStagingAgeMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

function unsafe(message: string, cause?: unknown): never {
  throw new ArtifactStoreError(
    "ARTIFACT_PATH_UNSAFE",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function validateMediaType(mediaType: string) {
  if (
    typeof mediaType !== "string" ||
    mediaType.length > 255 ||
    !mediaTypePattern.test(mediaType)
  ) {
    throw new ArtifactStoreError(
      "ARTIFACT_INPUT_INVALID",
      "Invalid artifact mediaType.",
    );
  }
}

function coordinates(runId: string, name: string): ArtifactCoordinates {
  try {
    return createArtifactCoordinates(runId, name);
  } catch (error) {
    if (error instanceof ArtifactUriError) {
      throw new ArtifactStoreError(
        "ARTIFACT_INPUT_INVALID",
        error.message,
        { cause: error },
      );
    }
    throw error;
  }
}

function parseArtifactUri(uri: string): ArtifactCoordinates {
  try {
    return parseCanonicalArtifactUri(uri);
  } catch (error) {
    if (error instanceof ArtifactUriError) {
      throw new ArtifactStoreError(
        "ARTIFACT_URI_INVALID",
        error.message,
        { cause: error },
      );
    }
    throw error;
  }
}

function pathIsInside(root: string, candidate: string) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

function identityFrom(stat: { dev: number; ino: number }): Identity {
  return { device: stat.dev, inode: stat.ino };
}

function sameIdentity(left: Identity, right: Identity) {
  return left.device === right.device && left.inode === right.inode;
}

function artifactChecksum(body: Uint8Array) {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function physicalObjectName(location: ArtifactCoordinates) {
  return `artifact-${createHash("sha256").update(location.uri).digest("hex")}`;
}

function validatePhysicalBasename(name: string) {
  if (
    name.length === 0 ||
    name.length > 255 ||
    name === "." ||
    name === ".." ||
    basename(name) !== name ||
    !/^[A-Za-z0-9._-]+$/.test(name)
  ) {
    unsafe("Artifact physical object name is unsafe.");
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function asStoreError(error: unknown): never {
  if (error instanceof ArtifactStoreError) {
    throw error;
  }
  throw new ArtifactStoreError(
    "ARTIFACT_CORRUPT",
    "Artifact could not be verified.",
    { cause: error },
  );
}

async function snapshotDirectory(
  path: string,
  expectedParent?: DirectorySnapshot,
  missingBehavior: "unsafe" | "not-found" = "unsafe",
): Promise<DirectorySnapshot> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (
      missingBehavior === "not-found" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      if (expectedParent !== undefined) {
        await verifyDirectory(expectedParent);
      }
      throw new ArtifactStoreError(
        "ARTIFACT_NOT_FOUND",
        "Artifact does not exist.",
        { cause: error },
      );
    }
    unsafe("Artifact directory identity could not be verified.", error);
  }
  try {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      unsafe("Artifact path contains a non-directory or symlink component.");
    }
    const canonical = await realpath(path);
    if (
      canonical !== path ||
      (expectedParent !== undefined &&
        (dirname(canonical) !== expectedParent.canonical ||
          !pathIsInside(expectedParent.canonical, canonical)))
    ) {
      unsafe("Artifact directory canonical identity is unsafe.");
    }
    return { path, canonical, ...identityFrom(stat) };
  } catch (error) {
    if (error instanceof ArtifactStoreError) throw error;
    unsafe("Artifact directory identity changed while being verified.", error);
  }
}

async function verifyDirectory(snapshot: DirectorySnapshot) {
  const current = await snapshotDirectory(snapshot.path);
  if (
    current.canonical !== snapshot.canonical ||
    !sameIdentity(current, snapshot)
  ) {
    unsafe("Artifact directory identity changed during the operation.");
  }
}

async function snapshotFile(
  path: string,
  expectedParent: DirectorySnapshot,
  missingBehavior: "unsafe" | "corrupt" = "unsafe",
): Promise<FileSnapshot> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (
      missingBehavior === "corrupt" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      await verifyDirectory(expectedParent);
      throw new ArtifactStoreError(
        "ARTIFACT_CORRUPT",
        "Stored artifact is missing a required file.",
        { cause: error },
      );
    }
    unsafe("Artifact file identity could not be verified.", error);
  }
  try {
    if (!stat.isFile() || stat.isSymbolicLink()) {
      unsafe("Artifact file is not a regular non-symlink file.");
    }
    const canonical = await realpath(path);
    if (
      canonical !== path ||
      dirname(canonical) !== expectedParent.canonical ||
      !pathIsInside(expectedParent.canonical, canonical)
    ) {
      unsafe("Artifact file canonical identity is unsafe.");
    }
    return {
      path,
      canonical,
      byteSize: stat.size,
      ...identityFrom(stat),
    };
  } catch (error) {
    if (error instanceof ArtifactStoreError) throw error;
    unsafe("Artifact file identity changed while being verified.", error);
  }
}

async function verifyFile(snapshot: FileSnapshot, parent: DirectorySnapshot) {
  const current = await snapshotFile(snapshot.path, parent);
  if (
    current.canonical !== snapshot.canonical ||
    current.byteSize !== snapshot.byteSize ||
    !sameIdentity(current, snapshot)
  ) {
    unsafe("Artifact file identity changed during the operation.");
  }
}

async function verifyRoot(root: RootSnapshot) {
  try {
    const configuredStat = await lstat(root.configuredPath);
    if (
      !configuredStat.isDirectory() ||
      configuredStat.isSymbolicLink() ||
      !sameIdentity(identityFrom(configuredStat), root)
    ) {
      unsafe("SGEO_ARTIFACT_ROOT identity changed during the operation.");
    }
    const configuredCanonical = await realpath(root.configuredPath);
    if (configuredCanonical !== root.canonical) {
      unsafe("SGEO_ARTIFACT_ROOT canonical path changed during the operation.");
    }
    await verifyDirectory(root);
  } catch (error) {
    if (error instanceof ArtifactStoreError) throw error;
    unsafe("SGEO_ARTIFACT_ROOT could not be revalidated.", error);
  }
}

async function verifyChain(
  root: RootSnapshot,
  ...directories: DirectorySnapshot[]
) {
  await verifyRoot(root);
  let parent: DirectorySnapshot = root;
  for (const directory of directories) {
    const current = await snapshotDirectory(directory.path, parent);
    if (
      current.canonical !== directory.canonical ||
      !sameIdentity(current, directory)
    ) {
      unsafe("Artifact directory chain changed during the operation.");
    }
    parent = directory;
  }
  await verifyRoot(root);
}

async function openTrustedRoot(root: RootSnapshot) {
  const handle = await open(
    root.path,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || !sameIdentity(identityFrom(stat), root)) {
      unsafe("Root directory handle did not match its trusted identity.");
    }
    await verifyRoot(root);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyRootHandle(
  root: RootSnapshot,
  handle: FileHandle,
) {
  const stat = await handle.stat();
  if (!stat.isDirectory() || !sameIdentity(identityFrom(stat), root)) {
    unsafe("Root directory handle identity changed during the operation.");
  }
  await verifyRoot(root);
}

async function syncVerifiedDirectory(
  root: RootSnapshot,
  chain: DirectorySnapshot[],
) {
  const directory = chain.at(-1) ?? root;
  await verifyChain(root, ...chain);
  const handle = await open(
    directory.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = identityFrom(await handle.stat());
    if (!sameIdentity(opened, directory)) {
      unsafe("Directory handle identity did not match its trusted path.");
    }
    await verifyChain(root, ...chain);
    await handle.sync();
    if (!sameIdentity(identityFrom(await handle.stat()), directory)) {
      unsafe("Directory handle identity changed while syncing.");
    }
    await verifyChain(root, ...chain);
  } finally {
    await handle.close();
  }
}

async function cleanupOwnedDirectory(
  snapshot: DirectorySnapshot,
  candidates: string[],
) {
  const paths = new Set(candidates);
  for (const candidate of candidates) {
    try {
      paths.add(await realpath(candidate));
    } catch {
      // Missing candidates need no cleanup.
    }
  }
  for (const candidate of paths) {
    try {
      const stat = await lstat(candidate);
      if (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        sameIdentity(identityFrom(stat), snapshot)
      ) {
        await rm(candidate, { recursive: true, force: true });
      }
    } catch {
      // Cleanup is identity-limited and best effort after fail-closed errors.
    }
  }
}

type AnchoredRenameResult = "published" | "conflict";

async function anchoredRename(
  helperPath: string,
  rootHandle: FileHandle,
  sourceName: string,
  targetName: string,
): Promise<AnchoredRenameResult> {
  validatePhysicalBasename(sourceName);
  validatePhysicalBasename(targetName);
  if (!isAbsolute(helperPath) || resolve(helperPath) !== helperPath) {
    throw new ArtifactStoreError(
      "ARTIFACT_PUBLISH_UNAVAILABLE",
      "Artifact publication helper path is unavailable.",
    );
  }

  return new Promise((resolveRename, rejectRename) => {
    let settled = false;
    let errorOutput = "";
    const child = spawn(helperPath, [sourceName, targetName], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe", rootHandle.fd],
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (errorOutput.length < helperErrorLimit) {
        errorOutput += chunk.slice(0, helperErrorLimit - errorOutput.length);
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      const unavailable = error.code === "ENOENT" || error.code === "EACCES";
      rejectRename(new ArtifactStoreError(
        unavailable
          ? "ARTIFACT_PUBLISH_UNAVAILABLE"
          : "ARTIFACT_PUBLISH_FAILED",
        unavailable
          ? "Artifact publication helper is unavailable."
          : "Artifact publication helper could not start.",
        { cause: error },
      ));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolveRename("published");
        return;
      }
      if (code === helperConflictExitCode) {
        resolveRename("conflict");
        return;
      }
      const unavailable = code === helperUnavailableExitCode;
      rejectRename(new ArtifactStoreError(
        unavailable
          ? "ARTIFACT_PUBLISH_UNAVAILABLE"
          : "ARTIFACT_PUBLISH_FAILED",
        unavailable
          ? "Artifact publication is unsupported on this platform."
          : "Artifact publication helper failed.",
        {
          cause: new Error(
            errorOutput.trim() ||
              `helper exited with ${code ?? `signal ${signal ?? "unknown"}`}`,
          ),
        },
      ));
    });
  });
}

export class LocalArtifactStore implements ArtifactStore {
  private readonly configuredRoot: string;
  private readonly renameHelperPath: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    root?: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly testHooks: LocalArtifactStoreTestHooks = {},
  ) {
    const configured = root ?? env.SGEO_ARTIFACT_ROOT;
    if (!configured?.trim()) {
      throw new ArtifactStoreError(
        "ARTIFACT_ROOT_REQUIRED",
        "SGEO_ARTIFACT_ROOT is required.",
      );
    }
    if (
      configured.includes("\0") ||
      !isAbsolute(configured) ||
      resolve(configured) !== configured
    ) {
      throw new ArtifactStoreError(
        "ARTIFACT_ROOT_INVALID",
        "SGEO_ARTIFACT_ROOT must be a canonical absolute path.",
      );
    }
    this.configuredRoot = configured;
    const configuredHelper = env.SGEO_ARTIFACT_RENAME_HELPER?.trim();
    this.renameHelperPath = configuredHelper ||
      resolve(process.cwd(), ".sgeo-native", "sgeo-renameat-helper");
  }

  async put(
    runId: string,
    name: string,
    body: Uint8Array,
    mediaType: string,
  ): Promise<StoredArtifact> {
    const location = coordinates(runId, name);
    validateMediaType(mediaType);
    if (!(body instanceof Uint8Array) || body.byteLength > 2_147_483_647) {
      throw new ArtifactStoreError(
        "ARTIFACT_INPUT_INVALID",
        "Artifact body must be a supported Uint8Array.",
      );
    }
    const stableBody = new Uint8Array(body);
    return this.withLock(location.uri, () =>
      this.publish(location, stableBody, mediaType)
    );
  }

  async get(uri: string): Promise<Uint8Array> {
    const location = parseArtifactUri(uri);
    return this.withLock(location.uri, async () => {
      const artifact = await this.readStored(location);
      return new Uint8Array(artifact.body);
    });
  }

  private async withLock<T>(key: string, operation: () => Promise<T>) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) {
        this.locks.delete(key);
      }
    }
  }

  private async trustedRoot(): Promise<RootSnapshot> {
    try {
      await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 });
      const configuredStat = await lstat(this.configuredRoot);
      if (
        !configuredStat.isDirectory() ||
        configuredStat.isSymbolicLink()
      ) {
        throw new ArtifactStoreError(
          "ARTIFACT_ROOT_INVALID",
          "SGEO_ARTIFACT_ROOT must be a real directory.",
        );
      }
      const canonical = await realpath(this.configuredRoot);
      const canonicalStat = await lstat(canonical);
      if (
        !canonicalStat.isDirectory() ||
        canonicalStat.isSymbolicLink() ||
        !sameIdentity(
          identityFrom(configuredStat),
          identityFrom(canonicalStat),
        )
      ) {
        throw new ArtifactStoreError(
          "ARTIFACT_ROOT_INVALID",
          "SGEO_ARTIFACT_ROOT identity is ambiguous.",
        );
      }
      const root = {
        configuredPath: this.configuredRoot,
        path: canonical,
        canonical,
        ...identityFrom(canonicalStat),
      };
      await verifyRoot(root);
      return root;
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        "ARTIFACT_ROOT_INVALID",
        "SGEO_ARTIFACT_ROOT is unavailable.",
        { cause: error },
      );
    }
  }

  private async scavengeStaleStaging(root: RootSnapshot) {
    const now = this.testHooks.now?.() ?? Date.now();
    const minimumAge =
      this.testHooks.staleStagingAgeMs ?? defaultStaleStagingAgeMs;
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(minimumAge) ||
      minimumAge <= 0
    ) {
      unsafe("Artifact staging cleanup configuration is invalid.");
    }

    await verifyRoot(root);
    const entries = await readdir(root.path, { withFileTypes: true }).catch(
      (error) => unsafe("Artifact staging root could not be inspected.", error),
    );
    for (const entry of entries) {
      const match = stagingNamePattern.exec(entry.name);
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      const pid = Number(match[1]);
      const createdAt = Number(match[2]);
      const path = join(root.path, entry.name);
      let stat;
      try {
        stat = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        unsafe("Artifact staging candidate could not be inspected.", error);
      }
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        now - Math.max(createdAt, stat.mtimeMs) < minimumAge
      ) {
        continue;
      }
      const alive = this.testHooks.isProcessAlive?.(pid) ??
        processIsAlive(pid);
      if (alive) continue;

      const stale = await snapshotDirectory(path, root);
      await verifyChain(root, stale);
      await cleanupOwnedDirectory(stale, [path]);
    }
    await verifyRoot(root);
  }

  private async createStagingDirectory(root: RootSnapshot) {
    await verifyRoot(root);
    const now = this.testHooks.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      unsafe("Artifact staging clock is invalid.");
    }
    const path = await mkdtemp(
      join(root.path, `.artifact-tmp-${process.pid}-${now}-`),
    );
    const staging = await snapshotDirectory(path, root);
    await verifyChain(root, staging);
    return staging;
  }

  private async writeStagedFile(
    root: RootSnapshot,
    staging: DirectorySnapshot,
    name: string,
    body: Uint8Array,
  ) {
    await verifyChain(root, staging);
    const path = join(staging.path, name);
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const opened = identityFrom(await handle.stat());
      const created = await snapshotFile(path, staging);
      if (!sameIdentity(opened, created)) {
        unsafe("New artifact file handle did not match its path.");
      }
      await verifyChain(root, staging);
      await handle.writeFile(body);
      await handle.sync();
      const completedStat = await handle.stat();
      const completed: FileSnapshot = {
        path,
        canonical: path,
        byteSize: completedStat.size,
        ...identityFrom(completedStat),
      };
      await verifyFile(completed, staging);
      await verifyChain(root, staging);
      return completed;
    } finally {
      await handle.close();
    }
  }

  private async publish(
    location: ArtifactCoordinates,
    body: Uint8Array,
    mediaType: string,
  ): Promise<StoredArtifact> {
    const root = await this.trustedRoot();
    await this.scavengeStaleStaging(root);
    const rootHandle = await openTrustedRoot(root);
    const checksum = artifactChecksum(body);
    const stored: StoredArtifact = {
      uri: location.uri,
      checksum,
      mediaType,
      byteSize: body.byteLength,
    };
    const targetName = physicalObjectName(location);
    validatePhysicalBasename(targetName);
    const target = join(root.path, targetName);

    let staging: DirectorySnapshot | undefined;
    let published = false;
    try {
      try {
        await lstat(target);
        return await this.assertIdempotent(location, stored, body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          if (error instanceof ArtifactStoreError) throw error;
          return asStoreError(error);
        }
      }

      staging = await this.createStagingDirectory(root);
      const stagingName = basename(staging.path);
      validatePhysicalBasename(stagingName);
      await this.writeStagedFile(root, staging, "payload", body);
      const metadata = new TextEncoder().encode(JSON.stringify({
        version: 1,
        ...stored,
      }));
      await this.writeStagedFile(
        root,
        staging,
        "metadata.json",
        metadata,
      );
      await syncVerifiedDirectory(root, [staging]);
      await verifyRootHandle(root, rootHandle);
      await verifyChain(root, staging);
      await this.testHooks.beforePublishRename?.();
      await verifyRootHandle(root, rootHandle);

      const result = await anchoredRename(
        this.renameHelperPath,
        rootHandle,
        stagingName,
        targetName,
      );
      if (result === "conflict") {
        await cleanupOwnedDirectory(staging, [staging.path]);
        staging = undefined;
        return await this.assertIdempotent(location, stored, body);
      }

      const publishedDirectory = await snapshotDirectory(target, root);
      if (!sameIdentity(publishedDirectory, staging)) {
        unsafe("Published artifact identity did not match its staging object.");
      }
      await verifyRootHandle(root, rootHandle);
      await verifyChain(root, publishedDirectory);
      await rootHandle.sync();
      await verifyRootHandle(root, rootHandle);
      await verifyChain(root, publishedDirectory);
      published = true;
      return stored;
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      return asStoreError(error);
    } finally {
      if (!published && staging !== undefined) {
        await cleanupOwnedDirectory(staging, [
          staging.path,
          target,
        ]);
      }
      await rootHandle.close();
    }
  }

  private async assertIdempotent(
    location: ArtifactCoordinates,
    expected: StoredArtifact,
    body: Uint8Array,
  ) {
    const existing = await this.readStored(location);
    if (
      existing.metadata.uri === expected.uri &&
      existing.metadata.checksum === expected.checksum &&
      existing.metadata.mediaType === expected.mediaType &&
      existing.metadata.byteSize === expected.byteSize &&
      Buffer.from(existing.body).equals(Buffer.from(body))
    ) {
      return expected;
    }
    throw new ArtifactStoreError(
      "ARTIFACT_CONFLICT",
      "Artifact URI already contains different immutable content.",
    );
  }

  private async readVerifiedFile(
    root: RootSnapshot,
    object: DirectorySnapshot,
    name: string,
    expectedSize?: number,
    maximumSize?: number,
  ) {
    await verifyChain(root, object);
    const path = join(object.path, name);
    const before = await snapshotFile(path, object, "corrupt");
    if (
      expectedSize !== undefined &&
      before.byteSize !== expectedSize
    ) {
      throw new ArtifactStoreError(
        "ARTIFACT_CORRUPT",
        "Artifact file size does not match trusted metadata.",
      );
    }
    if (maximumSize !== undefined && before.byteSize > maximumSize) {
      throw new ArtifactStoreError(
        "ARTIFACT_CORRUPT",
        "Artifact file exceeds its verified size limit.",
      );
    }
    let handle: FileHandle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        unsafe("Artifact file changed before it could be opened.", error);
      }
      throw error;
    }
    try {
      if (!sameIdentity(identityFrom(await handle.stat()), before)) {
        unsafe("Artifact read handle did not match its trusted path.");
      }
      await verifyFile(before, object);
      await verifyChain(root, object);
      const bytes = Buffer.allocUnsafe(before.byteSize);
      let offset = 0;
      while (offset < before.byteSize) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          before.byteSize - offset,
          offset,
        );
        if (bytesRead === 0) {
          unsafe("Artifact file was truncated while reading.");
        }
        offset += bytesRead;
      }
      const probe = Buffer.allocUnsafe(1);
      const trailing = await handle.read(probe, 0, 1, before.byteSize);
      if (trailing.bytesRead !== 0) {
        unsafe("Artifact file grew while reading.");
      }
      const afterStat = await handle.stat();
      const after: FileSnapshot = {
        path,
        canonical: path,
        byteSize: afterStat.size,
        ...identityFrom(afterStat),
      };
      if (
        !sameIdentity(after, before) ||
        after.byteSize !== before.byteSize ||
        bytes.byteLength !== before.byteSize
      ) {
        unsafe("Artifact file changed while reading.");
      }
      await verifyFile(before, object);
      await verifyChain(root, object);
      return { bytes: new Uint8Array(bytes), snapshot: before };
    } finally {
      await handle.close();
    }
  }

  private async readStored(location: ArtifactCoordinates) {
    try {
      const root = await this.trustedRoot();
      const objectPath = join(root.path, physicalObjectName(location));
      const object = await snapshotDirectory(objectPath, root, "not-found");
      await this.testHooks.afterObjectSnapshot?.();
      await verifyChain(root, object);

      const metadataRead = await this.readVerifiedFile(
        root,
        object,
        "metadata.json",
        undefined,
        metadataLimit,
      );
      if (
        metadataRead.bytes.byteLength === 0
      ) {
        throw new ArtifactStoreError(
          "ARTIFACT_CORRUPT",
          "Artifact metadata is invalid.",
        );
      }
      const parsed = metadataSchema.safeParse(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(metadataRead.bytes),
      ));
      if (
        !parsed.success ||
        parsed.data.uri !== location.uri ||
        !mediaTypePattern.test(parsed.data.mediaType)
      ) {
        throw new ArtifactStoreError(
          "ARTIFACT_CORRUPT",
          "Artifact metadata does not match its URI.",
        );
      }

      const payloadRead = await this.readVerifiedFile(
        root,
        object,
        "payload",
        parsed.data.byteSize,
      );
      await verifyFile(metadataRead.snapshot, object);
      await verifyFile(payloadRead.snapshot, object);
      await verifyChain(root, object);
      if (artifactChecksum(payloadRead.bytes) !== parsed.data.checksum) {
        throw new ArtifactStoreError(
          "ARTIFACT_CORRUPT",
          "Artifact checksum does not match its payload.",
        );
      }
      await verifyChain(root, object);
      return { metadata: parsed.data, body: payloadRead.bytes };
    } catch (error) {
      return asStoreError(error);
    }
  }
}
