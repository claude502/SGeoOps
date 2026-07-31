import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import type { ArtifactStore, StoredArtifact } from "@/lib/artifacts/store";

const checksumPattern = /^sha256:[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
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

export type ArtifactStoreErrorCode =
  | "ARTIFACT_ROOT_REQUIRED"
  | "ARTIFACT_ROOT_INVALID"
  | "ARTIFACT_INPUT_INVALID"
  | "ARTIFACT_URI_INVALID"
  | "ARTIFACT_PATH_UNSAFE"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_CONFLICT"
  | "ARTIFACT_CORRUPT";

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

type ArtifactCoordinates = {
  runId: string;
  name: string;
  uri: string;
};

function validateIdentifier(
  value: string,
  field: "runId" | "name",
  maximumLength: number,
) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value === "." ||
    value === ".." ||
    !identifierPattern.test(value)
  ) {
    throw new ArtifactStoreError(
      "ARTIFACT_INPUT_INVALID",
      `Invalid artifact ${field}.`,
    );
  }
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
  validateIdentifier(runId, "runId", 128);
  validateIdentifier(name, "name", 255);
  return {
    runId,
    name,
    uri: `artifact://${runId}/${name}`,
  };
}

function parseArtifactUri(uri: string): ArtifactCoordinates {
  if (
    typeof uri !== "string" ||
    uri.length > 512 ||
    uri.includes("\0") ||
    uri.includes("%") ||
    uri.includes("\\") ||
    uri.includes("?") ||
    uri.includes("#")
  ) {
    throw new ArtifactStoreError(
      "ARTIFACT_URI_INVALID",
      "Artifact URI is not canonical.",
    );
  }
  const match = /^artifact:\/\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match) {
    throw new ArtifactStoreError(
      "ARTIFACT_URI_INVALID",
      "Artifact URI is not canonical.",
    );
  }
  try {
    const parsed = coordinates(match[1], match[2]);
    if (parsed.uri !== uri) {
      throw new Error("non-canonical");
    }
    return parsed;
  } catch (error) {
    if (
      error instanceof ArtifactStoreError &&
      error.code === "ARTIFACT_INPUT_INVALID"
    ) {
      throw new ArtifactStoreError(
        "ARTIFACT_URI_INVALID",
        "Artifact URI is not canonical.",
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

function artifactChecksum(body: Uint8Array) {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function asStoreError(error: unknown, notFoundCode = false): never {
  if (error instanceof ArtifactStoreError) {
    throw error;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (notFoundCode && code === "ENOENT") {
    throw new ArtifactStoreError(
      "ARTIFACT_NOT_FOUND",
      "Artifact does not exist.",
      { cause: error },
    );
  }
  throw new ArtifactStoreError(
    "ARTIFACT_CORRUPT",
    "Artifact could not be verified.",
    { cause: error },
  );
}

export class LocalArtifactStore implements ArtifactStore {
  private readonly configuredRoot: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    root?: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
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

  private async trustedRoot() {
    try {
      await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 });
      const rootStat = await lstat(this.configuredRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new ArtifactStoreError(
          "ARTIFACT_ROOT_INVALID",
          "SGEO_ARTIFACT_ROOT must be a real directory.",
        );
      }
      return await realpath(this.configuredRoot);
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        "ARTIFACT_ROOT_INVALID",
        "SGEO_ARTIFACT_ROOT is unavailable.",
        { cause: error },
      );
    }
  }

  private async trustedRunDirectory(root: string, runId: string) {
    const runDirectory = join(root, runId);
    try {
      await mkdir(runDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const runStat = await lstat(runDirectory);
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
      throw new ArtifactStoreError(
        "ARTIFACT_PATH_UNSAFE",
        "Artifact run directory is unsafe.",
      );
    }
    const realRunDirectory = await realpath(runDirectory);
    if (!pathIsInside(root, realRunDirectory)) {
      throw new ArtifactStoreError(
        "ARTIFACT_PATH_UNSAFE",
        "Artifact run directory escapes the configured root.",
      );
    }
    return realRunDirectory;
  }

  private async publish(
    location: ArtifactCoordinates,
    body: Uint8Array,
    mediaType: string,
  ): Promise<StoredArtifact> {
    const root = await this.trustedRoot();
    const runDirectory = await this.trustedRunDirectory(root, location.runId);
    const checksum = artifactChecksum(body);
    const stored: StoredArtifact = {
      uri: location.uri,
      checksum,
      mediaType,
      byteSize: body.byteLength,
    };
    const target = join(runDirectory, location.name);

    try {
      await lstat(target);
      return await this.assertIdempotent(location, stored, body);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof ArtifactStoreError) throw error;
        return asStoreError(error);
      }
    }

    const temporary = await mkdtemp(join(runDirectory, ".artifact-tmp-"));
    let published = false;
    try {
      const payloadPath = join(temporary, "payload");
      const metadataPath = join(temporary, "metadata.json");
      const payloadHandle = await open(
        payloadPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await payloadHandle.writeFile(body);
        await payloadHandle.sync();
      } finally {
        await payloadHandle.close();
      }

      const metadata = Buffer.from(JSON.stringify({
        version: 1,
        ...stored,
      }));
      const metadataHandle = await open(
        metadataPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await metadataHandle.writeFile(metadata);
        await metadataHandle.sync();
      } finally {
        await metadataHandle.close();
      }
      await syncDirectory(temporary);

      try {
        await rename(temporary, target);
        published = true;
        await syncDirectory(runDirectory);
        return stored;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") {
          throw error;
        }
        return await this.assertIdempotent(location, stored, body);
      }
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      return asStoreError(error);
    } finally {
      if (!published) {
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
      }
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

  private async readStored(location: ArtifactCoordinates) {
    try {
      const root = await this.trustedRoot();
      const runDirectory = join(root, location.runId);
      const runStat = await lstat(runDirectory);
      if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
        throw new ArtifactStoreError(
          "ARTIFACT_PATH_UNSAFE",
          "Artifact run directory is unsafe.",
        );
      }
      const trustedRun = await realpath(runDirectory);
      if (!pathIsInside(root, trustedRun)) {
        throw new ArtifactStoreError(
          "ARTIFACT_PATH_UNSAFE",
          "Artifact run directory escapes the configured root.",
        );
      }

      const objectDirectory = join(trustedRun, location.name);
      const objectStat = await lstat(objectDirectory);
      if (!objectStat.isDirectory() || objectStat.isSymbolicLink()) {
        throw new ArtifactStoreError(
          "ARTIFACT_PATH_UNSAFE",
          "Artifact object path is unsafe.",
        );
      }
      const trustedObject = await realpath(objectDirectory);
      if (!pathIsInside(root, trustedObject)) {
        throw new ArtifactStoreError(
          "ARTIFACT_PATH_UNSAFE",
          "Artifact object escapes the configured root.",
        );
      }

      const metadata = await this.readMetadata(
        join(trustedObject, "metadata.json"),
        location.uri,
      );
      const body = await this.readPayload(
        join(trustedObject, "payload"),
        metadata.byteSize,
      );
      if (artifactChecksum(body) !== metadata.checksum) {
        throw new ArtifactStoreError(
          "ARTIFACT_CORRUPT",
          "Artifact checksum does not match its payload.",
        );
      }
      return { metadata, body };
    } catch (error) {
      return asStoreError(error, true);
    }
  }

  private async readMetadata(path: string, expectedUri: string) {
    const pathStat = await lstat(path);
    if (
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      pathStat.size === 0 ||
      pathStat.size > metadataLimit
    ) {
      throw new ArtifactStoreError(
        "ARTIFACT_CORRUPT",
        "Artifact metadata is invalid.",
      );
    }
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.size !== pathStat.size) {
        throw new ArtifactStoreError(
          "ARTIFACT_CORRUPT",
          "Artifact metadata changed while opening.",
        );
      }
      const bytes = await handle.readFile();
      const parsed = metadataSchema.safeParse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (
        !parsed.success ||
        parsed.data.uri !== expectedUri ||
        !mediaTypePattern.test(parsed.data.mediaType)
      ) {
        throw new ArtifactStoreError(
          "ARTIFACT_CORRUPT",
          "Artifact metadata does not match its URI.",
        );
      }
      return parsed.data;
    } finally {
      await handle.close();
    }
  }

  private async readPayload(path: string, expectedSize: number) {
    const pathStat = await lstat(path);
    if (
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      pathStat.size !== expectedSize
    ) {
      throw new ArtifactStoreError(
        "ARTIFACT_CORRUPT",
        "Artifact payload size does not match its metadata.",
      );
    }
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.size !== expectedSize) {
        throw new ArtifactStoreError(
          "ARTIFACT_CORRUPT",
          "Artifact payload changed while opening.",
        );
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength !== expectedSize) {
        throw new ArtifactStoreError(
          "ARTIFACT_CORRUPT",
          "Artifact payload was truncated while reading.",
        );
      }
      return new Uint8Array(bytes);
    } finally {
      await handle.close();
    }
  }
}
