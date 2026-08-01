import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactStoreError,
  LocalArtifactStore,
  type LocalArtifactStoreTestHooks,
} from "@/lib/artifacts/local-store";

const temporaryRoots: string[] = [];
const renameHelperPath = fileURLToPath(
  new URL("../../../.sgeo-native/sgeo-renameat-helper", import.meta.url),
);

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "sgeo-artifacts-"));
  temporaryRoots.push(root);
  return root;
}

function storeWithHooks(
  root: string,
  hooks: LocalArtifactStoreTestHooks,
) {
  return new LocalArtifactStore(root, {}, hooks);
}

function checksum(body: Uint8Array) {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function objectName(runId: string, name: string) {
  const uri = `artifact://${runId}/${name}`;
  return `artifact-${createHash("sha256").update(uri).digest("hex")}`;
}

function objectDirectory(root: string, runId: string, name: string) {
  return join(root, objectName(runId, name));
}

async function runPutProcess(root: string, name: string, body: string) {
  const fixture = fileURLToPath(
    new URL("../../../tests/fixtures/artifact-put-process.ts", import.meta.url),
  );
  return new Promise<number | null>((resolveProcess, rejectProcess) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fixture],
      {
        cwd: dirname(fixture),
        env: {
          ...process.env,
          SGEO_PROCESS_ARTIFACT_ROOT: root,
          SGEO_PROCESS_ARTIFACT_NAME: name,
          SGEO_PROCESS_ARTIFACT_BODY: body,
          SGEO_ARTIFACT_RENAME_HELPER: renameHelperPath,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let errorOutput = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    child.once("error", rejectProcess);
    child.once("close", (code) => {
      if (code !== 0 && code !== 2) {
        rejectProcess(new Error(errorOutput || `child exited ${code}`));
        return;
      }
      resolveProcess(code);
    });
  });
}

async function runAnchoredRenameHelper(
  rootFd: number,
  sourceName: string,
  targetName: string,
) {
  return new Promise<{ code: number | null; stderr: string }>(
    (resolveProcess, rejectProcess) => {
      const child = spawn(renameHelperPath, [sourceName, targetName], {
        shell: false,
        stdio: ["ignore", "ignore", "pipe", rootFd],
      });
      const stderrStream = child.stderr!;
      let stderr = "";
      stderrStream.setEncoding("utf8");
      stderrStream.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", rejectProcess);
      child.once("close", (code) => resolveProcess({ code, stderr }));
    },
  );
}

async function writeArtifactObject(
  objectDirectory: string,
  uri: string,
  body: Uint8Array,
) {
  await mkdir(objectDirectory, { recursive: true });
  await writeFile(join(objectDirectory, "payload"), body);
  await writeFile(join(objectDirectory, "metadata.json"), JSON.stringify({
    version: 1,
    uri,
    checksum: checksum(body),
    mediaType: "application/octet-stream",
    byteSize: body.byteLength,
  }));
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("LocalArtifactStore", () => {
  it("fails closed when SGEO_ARTIFACT_ROOT is absent", () => {
    expect(() => new LocalArtifactStore(undefined, {})).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_ROOT_REQUIRED" }),
    );
  });

  it("publishes and verifies an immutable artifact", async () => {
    const root = await temporaryRoot();
    const store = new LocalArtifactStore(root);
    const bytes = new TextEncoder().encode('{"score":91}');

    const stored = await store.put(
      "run_1",
      "report.json",
      bytes,
      "application/json",
    );

    expect(stored).toEqual({
      uri: "artifact://run_1/report.json",
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      mediaType: "application/json",
      byteSize: bytes.byteLength,
    });
    await expect(store.getMetadata(stored.uri)).resolves.toEqual(stored);
    const firstRead = await store.get(stored.uri);
    const secondRead = await store.get(stored.uri);
    expect(firstRead).toEqual(bytes);
    expect(secondRead).toEqual(bytes);
    expect(firstRead).not.toBe(secondRead);
    await expect(lstat(join(root, "run_1")).catch(() => null)).resolves.toBeNull();
    await expect(
      lstat(objectDirectory(root, "run_1", "report.json")),
    ).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it("keeps streamed bytes private until their exact metadata is committed", async () => {
    const root = await temporaryRoot();
    const store = new LocalArtifactStore(root);
    const bytes = new TextEncoder().encode('{"score":91}');
    const upload = await store.beginUpload(
      "run_1",
      "report.json",
      "application/json",
      1_024,
    );

    await upload.write(bytes.subarray(0, 4));
    await upload.write(bytes.subarray(4));
    expect(await readdir(root)).not.toContain(
      objectName("run_1", "report.json"),
    );

    const stored = await upload.commit({
      uri: "artifact://run_1/report.json",
      checksum: checksum(bytes),
      mediaType: "application/json",
      byteSize: bytes.byteLength,
    });

    expect(stored).toEqual({
      uri: "artifact://run_1/report.json",
      checksum: checksum(bytes),
      mediaType: "application/json",
      byteSize: bytes.byteLength,
    });
    await expect(store.get(stored.uri)).resolves.toEqual(bytes);
  });

  it("preserves a concurrent artifact when streamed publication finds its target", async () => {
    const root = await temporaryRoot();
    const winner = new LocalArtifactStore(root);
    const contender = new LocalArtifactStore(root);
    const bytes = new Uint8Array([7, 8, 9]);
    const expected = {
      uri: "artifact://run_1/race.bin",
      checksum: checksum(bytes),
      mediaType: "application/octet-stream",
      byteSize: bytes.byteLength,
    };
    await winner.put(
      "run_1",
      "race.bin",
      bytes,
      "application/octet-stream",
    );
    const upload = await contender.beginUpload(
      "run_1",
      "race.bin",
      "application/octet-stream",
      1_024,
    );
    await upload.write(bytes);

    await expect(upload.commit(expected)).resolves.toEqual(expected);
    await expect(winner.get(expected.uri)).resolves.toEqual(bytes);
    expect((await readdir(root)).filter((name) =>
      name.startsWith(".artifact-tmp-")
    )).toEqual([]);
  });

  it("cleans staged bytes when streamed metadata does not match their checksum", async () => {
    const root = await temporaryRoot();
    const store = new LocalArtifactStore(root);
    const bytes = new Uint8Array([3, 2, 1]);
    const upload = await store.beginUpload(
      "run_1",
      "mismatch.bin",
      "application/octet-stream",
      1_024,
    );
    await upload.write(bytes);

    await expect(upload.commit({
      uri: "artifact://run_1/mismatch.bin",
      checksum: `sha256:${"a".repeat(64)}`,
      mediaType: "application/octet-stream",
      byteSize: bytes.byteLength,
    })).rejects.toMatchObject({ code: "ARTIFACT_CONFLICT" });

    await expect(store.get("artifact://run_1/mismatch.bin")).rejects
      .toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
    expect((await readdir(root)).filter((name) =>
      name.startsWith(".artifact-tmp-")
    )).toEqual([]);
  });

  it("removes a bounded streaming upload when it exceeds its byte ceiling", async () => {
    const root = await temporaryRoot();
    const store = new LocalArtifactStore(root);
    const upload = await store.beginUpload(
      "run_1",
      "report.bin",
      "application/octet-stream",
      3,
    );

    await upload.write(new Uint8Array([1, 2]));
    await expect(upload.write(new Uint8Array([3, 4]))).rejects
      .toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
    await upload.abort();

    await expect(store.get("artifact://run_1/report.bin")).rejects
      .toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
    expect((await readdir(root)).filter((name) =>
      name.startsWith(".artifact-tmp-")
    )).toEqual([]);
  });

  it.each([
    ["run id traversal", "../run", "report.json", "application/json"],
    ["run id separator", "run/1", "report.json", "application/json"],
    ["name traversal", "run_1", "..", "application/json"],
    ["name separator", "run_1", "nested/report.json", "application/json"],
    ["encoded traversal", "run_1", "%2e%2e", "application/json"],
    ["nul", "run_1", "report\u0000.json", "application/json"],
    ["invalid media type", "run_1", "report.json", "json"],
  ])("rejects %s on put", async (_label, runId, name, mediaType) => {
    const store = new LocalArtifactStore(await temporaryRoot());

    await expect(
      store.put(runId, name, new Uint8Array([1]), mediaType),
    ).rejects.toBeInstanceOf(ArtifactStoreError);
  });

  it.each([
    "file:///run_1/report.json",
    "artifact:///report.json",
    "artifact://run_1/../report.json",
    "artifact://run_1/%2e%2e",
    "artifact://run_1/nested/report.json",
    "artifact://user@run_1/report.json",
    "artifact://run_1/report.json?download=1",
    "artifact://run_1/report.json#fragment",
    "artifact://run_1/report\u0000.json",
  ])("rejects a non-canonical URI: %s", async (uri) => {
    const store = new LocalArtifactStore(await temporaryRoot());

    await expect(store.get(uri)).rejects.toBeInstanceOf(ArtifactStoreError);
  });

  it("is idempotent for identical bytes and media type", async () => {
    const store = new LocalArtifactStore(await temporaryRoot());
    const body = new Uint8Array([0, 255, 1, 2]);

    const first = await store.put(
      "run_1",
      "report.bin",
      body,
      "application/octet-stream",
    );
    const second = await store.put(
      "run_1",
      "report.bin",
      body,
      "application/octet-stream",
    );

    expect(second).toEqual(first);
  });

  it.each([
    ["different bytes", new Uint8Array([2]), "application/octet-stream"],
    ["different media type", new Uint8Array([1]), "application/json"],
  ])("rejects an immutable %s conflict", async (_label, body, mediaType) => {
    const store = new LocalArtifactStore(await temporaryRoot());
    await store.put(
      "run_1",
      "report.bin",
      new Uint8Array([1]),
      "application/octet-stream",
    );

    await expect(
      store.put("run_1", "report.bin", body, mediaType),
    ).rejects.toMatchObject({ code: "ARTIFACT_CONFLICT" });
    await expect(
      store.get("artifact://run_1/report.bin"),
    ).resolves.toEqual(new Uint8Array([1]));
  });

  it("serializes concurrent identical and conflicting puts", async () => {
    const store = new LocalArtifactStore(await temporaryRoot());
    const firstBody = new Uint8Array([1, 2, 3]);
    const same = await Promise.all([
      store.put("run_1", "same.bin", firstBody, "application/octet-stream"),
      store.put("run_1", "same.bin", firstBody, "application/octet-stream"),
    ]);
    expect(same[0]).toEqual(same[1]);

    const settled = await Promise.allSettled([
      store.put("run_1", "race.bin", firstBody, "application/octet-stream"),
      store.put(
        "run_1",
        "race.bin",
        new Uint8Array([9]),
        "application/octet-stream",
      ),
    ]);
    expect(settled.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    await expect(
      store.get("artifact://run_1/race.bin"),
    ).resolves.toEqual(firstBody);
  });

  it("uses atomic publication across independent store instances", async () => {
    const root = await temporaryRoot();
    const firstStore = new LocalArtifactStore(root);
    const secondStore = new LocalArtifactStore(root);
    const body = new Uint8Array([5, 6, 7]);

    const identical = await Promise.all([
      firstStore.put(
        "run_1",
        "shared.bin",
        body,
        "application/octet-stream",
      ),
      secondStore.put(
        "run_1",
        "shared.bin",
        body,
        "application/octet-stream",
      ),
    ]);
    expect(identical[0]).toEqual(identical[1]);

    const conflicting = await Promise.allSettled([
      firstStore.put(
        "run_1",
        "shared-race.bin",
        new Uint8Array([1]),
        "application/octet-stream",
      ),
      secondStore.put(
        "run_1",
        "shared-race.bin",
        new Uint8Array([2]),
        "application/octet-stream",
      ),
    ]);
    expect(conflicting.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      (await readdir(root))
        .filter((name) => name.startsWith(".artifact-tmp-")),
    ).toEqual([]);
  });

  it("uses no-replace publication across separate Node processes", async () => {
    const root = await temporaryRoot();

    const identical = await Promise.all([
      runPutProcess(root, "shared.bin", "same"),
      runPutProcess(root, "shared.bin", "same"),
    ]);
    expect(identical).toEqual([0, 0]);

    const conflicting = await Promise.all([
      runPutProcess(root, "conflict.bin", "first"),
      runPutProcess(root, "conflict.bin", "second"),
    ]);
    expect(conflicting.sort()).toEqual([0, 2]);
  });

  it("rejects corrupted payloads and metadata", async () => {
    const root = await temporaryRoot();
    const store = new LocalArtifactStore(root);
    await store.put(
      "run_1",
      "report.bin",
      new Uint8Array([1, 2, 3]),
      "application/octet-stream",
    );
    const objectDir = objectDirectory(root, "run_1", "report.bin");

    await writeFile(join(objectDir, "payload"), new Uint8Array([1, 2]));
    await expect(
      store.get("artifact://run_1/report.bin"),
    ).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });

    await writeFile(join(objectDir, "metadata.json"), "{}");
    await expect(
      store.get("artifact://run_1/report.bin"),
    ).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });
  });

  it("rejects oversized sparse metadata before allocating its contents", async () => {
    const root = await temporaryRoot();
    const objectDir = objectDirectory(root, "run_1", "large.bin");
    await mkdir(objectDir);
    await writeFile(join(objectDir, "payload"), new Uint8Array([1]));
    await writeFile(join(objectDir, "metadata.json"), "");
    await truncate(join(objectDir, "metadata.json"), 64 * 1024 * 1024);
    const before = process.memoryUsage().arrayBuffers;

    await expect(
      new LocalArtifactStore(root).get("artifact://run_1/large.bin"),
    ).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });

    const allocated = process.memoryUsage().arrayBuffers - before;
    expect(allocated).toBeLessThan(16 * 1024 * 1024);
  });

  it("streams large payload verification for metadata lookups", async () => {
    const root = await temporaryRoot();
    const byteSize = 16 * 1024 * 1024;
    const uri = "artifact://run_1/metadata-large.bin";
    const objectDir = objectDirectory(root, "run_1", "metadata-large.bin");
    const payload = join(objectDir, "payload");
    const hash = createHash("sha256");
    const zeroes = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < byteSize; offset += zeroes.byteLength) {
      hash.update(zeroes.subarray(0, Math.min(zeroes.byteLength, byteSize - offset)));
    }
    const expectedChecksum = `sha256:${hash.digest("hex")}`;
    await mkdir(objectDir);
    await writeFile(payload, "");
    await truncate(payload, byteSize);
    await writeFile(join(objectDir, "metadata.json"), JSON.stringify({
      version: 1,
      uri,
      checksum: expectedChecksum,
      mediaType: "application/octet-stream",
      byteSize,
    }));
    const before = process.memoryUsage().arrayBuffers;

    await expect(new LocalArtifactStore(root).getMetadata(uri)).resolves.toEqual({
      uri,
      checksum: expectedChecksum,
      mediaType: "application/octet-stream",
      byteSize,
    });

    const allocated = process.memoryUsage().arrayBuffers - before;
    expect(allocated).toBeLessThan(4 * 1024 * 1024);
  });

  it("distinguishes missing objects from incomplete stored objects", async () => {
    const root = await temporaryRoot();
    const store = new LocalArtifactStore(root);

    await expect(
      store.get("artifact://run_1/missing.bin"),
    ).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });

    const missingMetadata = objectDirectory(root, "run_1", "no-metadata.bin");
    await mkdir(missingMetadata);
    await writeFile(join(missingMetadata, "payload"), new Uint8Array([1]));
    await expect(
      store.get("artifact://run_1/no-metadata.bin"),
    ).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });

    const missingPayload = objectDirectory(root, "run_1", "no-payload.bin");
    await mkdir(missingPayload);
    await writeFile(join(missingPayload, "metadata.json"), JSON.stringify({
      version: 1,
      uri: "artifact://run_1/no-payload.bin",
      checksum: checksum(new Uint8Array([1])),
      mediaType: "application/octet-stream",
      byteSize: 1,
    }));
    await expect(
      store.get("artifact://run_1/no-payload.bin"),
    ).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });
  });

  it("rejects root-external symlinks for writes and reads", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const store = new LocalArtifactStore(root);

    const linkedObject = objectDirectory(root, "run_link", "report.json");
    await symlink(outside, linkedObject, "dir");
    await expect(
      store.put(
        "run_link",
        "report.json",
        new Uint8Array([1]),
        "application/json",
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_UNSAFE" });

    await symlink(
      outside,
      objectDirectory(root, "run_1", "report.json"),
      "dir",
    );
    await expect(
      store.get("artifact://run_1/report.json"),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_UNSAFE" });

    expect((await lstat(linkedObject)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, "missing"), "utf8").catch(() => null))
      .toBeNull();
  });

  it("fails closed when the helper is missing and cleans staging", async () => {
    const root = await temporaryRoot();
    const store = new LocalArtifactStore(root, {
      SGEO_ARTIFACT_RENAME_HELPER: join(root, "missing-helper"),
    });

    await expect(
      store.put(
        "run_1",
        "report.bin",
        new Uint8Array([4, 5, 6]),
        "application/octet-stream",
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_PUBLISH_UNAVAILABLE" });
    expect(
      (await readdir(root))
        .filter((name) => name.startsWith(".artifact-tmp-")),
    ).toEqual([]);
  });

  it("fails closed when the helper exits unsuccessfully", async () => {
    const root = await temporaryRoot();
    const helper = join(root, "failing-helper");
    await writeFile(helper, "#!/usr/bin/env node\nprocess.exit(1);\n");
    await chmod(helper, 0o700);
    const store = new LocalArtifactStore(root, {
      SGEO_ARTIFACT_RENAME_HELPER: helper,
    });

    await expect(
      store.put(
        "run_1",
        "report.bin",
        new Uint8Array([4, 5, 6]),
        "application/octet-stream",
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_PUBLISH_FAILED" });
    expect(
      (await readdir(root))
        .filter((name) => name.startsWith(".artifact-tmp-")),
    ).toEqual([]);
  });

  it("never publishes into a replacement configured-root pathname", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "configured-root");
    const originalRoot = join(parent, "original-root");
    await mkdir(root);
    const trustedIdentity = await lstat(root);
    let replaced = false;
    const store = storeWithHooks(root, {
      async beforePublishRename() {
        if (replaced) return;
        replaced = true;
        await rename(root, originalRoot);
        await mkdir(root);
      },
    });

    await expect(
      store.put(
        "run_1",
        "report.bin",
        new Uint8Array([4, 5, 6]),
        "application/octet-stream",
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_UNSAFE" });

    const replacementIdentity = await lstat(root);
    const movedTrustedIdentity = await lstat(originalRoot);
    expect({
      dev: movedTrustedIdentity.dev,
      ino: movedTrustedIdentity.ino,
    }).toEqual({
      dev: trustedIdentity.dev,
      ino: trustedIdentity.ino,
    });
    expect({
      dev: replacementIdentity.dev,
      ino: replacementIdentity.ino,
    }).not.toEqual({
      dev: trustedIdentity.dev,
      ino: trustedIdentity.ino,
    });
    expect(await readdir(root)).toEqual([]);
    expect((await readdir(originalRoot)).some((entry) =>
      entry.startsWith("artifact-")
    )).toBe(false);
  });

  it("anchors the native helper syscall to the opened original root fd", async () => {
    const parent = await temporaryRoot();
    const configuredRoot = join(parent, "configured-root");
    const movedOriginalRoot = join(parent, "moved-original-root");
    const sourceName = ".artifact-tmp-123-1000-ABC123";
    const targetName = `artifact-${"a".repeat(64)}`;
    await mkdir(join(configuredRoot, sourceName), { recursive: true });
    const trustedIdentity = await lstat(configuredRoot);
    const rootHandle = await open(
      configuredRoot,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );

    try {
      await rename(configuredRoot, movedOriginalRoot);
      await mkdir(configuredRoot);

      const result = await runAnchoredRenameHelper(
        rootHandle.fd,
        sourceName,
        targetName,
      );

      expect(result).toEqual({ code: 0, stderr: "" });
    } finally {
      await rootHandle.close();
    }

    const movedIdentity = await lstat(movedOriginalRoot);
    expect({
      dev: movedIdentity.dev,
      ino: movedIdentity.ino,
    }).toEqual({
      dev: trustedIdentity.dev,
      ino: trustedIdentity.ino,
    });
    expect((await lstat(join(movedOriginalRoot, targetName))).isDirectory())
      .toBe(true);
    await expect(readdir(movedOriginalRoot)).resolves.toEqual([targetName]);
    await expect(readdir(configuredRoot)).resolves.toEqual([]);
  });

  it("scavenges only old inactive owned staging directories", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const oldTimestamp = 1_000;
    const now = 100_000;
    const stale = join(root, `.artifact-tmp-999999-${oldTimestamp}-ABC123`);
    const active = join(root, `.artifact-tmp-111-${oldTimestamp}-ABC123`);
    const fresh = join(root, `.artifact-tmp-999998-${now - 1_000}-ABC123`);
    const unknown = join(root, ".artifact-tmp-legacy");
    const linked = join(root, `.artifact-tmp-999997-${oldTimestamp}-ABC123`);
    await Promise.all([
      mkdir(stale),
      mkdir(active),
      mkdir(fresh),
      mkdir(unknown),
    ]);
    await writeFile(join(stale, "payload"), new Uint8Array([1]));
    await Promise.all([
      utimes(stale, oldTimestamp / 1_000, oldTimestamp / 1_000),
      utimes(active, oldTimestamp / 1_000, oldTimestamp / 1_000),
      utimes(fresh, (now - 1_000) / 1_000, (now - 1_000) / 1_000),
      symlink(outside, linked, "dir"),
    ]);
    const store = storeWithHooks(root, {
      now: () => now,
      staleStagingAgeMs: 10_000,
      isProcessAlive: (pid) => pid === 111,
    });

    await store.put(
      "run_1",
      "report.bin",
      new Uint8Array([1]),
      "application/octet-stream",
    );

    await expect(lstat(stale).catch(() => null)).resolves.toBeNull();
    await expect(lstat(active)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(lstat(fresh)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(lstat(unknown)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
  });

  it("single-flights concurrent stores when a stale candidate disappears", async () => {
    const root = await temporaryRoot();
    const now = 100_000;
    const stale = join(root, ".artifact-tmp-999999-1000-ABC123");
    await mkdir(stale);
    await utimes(stale, 1, 1);
    let scans = 0;
    let candidateChecks = 0;
    const hooks: LocalArtifactStoreTestHooks = {
      now: () => now,
      staleStagingAgeMs: 10_000,
      stagingMaintenanceIntervalMs: 5_000,
      isProcessAlive: () => false,
      onStagingScan: () => {
        scans += 1;
      },
      async afterStaleCandidateLstat(path) {
        candidateChecks += 1;
        await rm(path, { recursive: true, force: true });
      },
    };
    const first = storeWithHooks(root, hooks);
    const second = storeWithHooks(root, hooks);

    await expect(Promise.all([
      first.put(
        "run_1",
        "first.bin",
        new Uint8Array([1]),
        "application/octet-stream",
      ),
      second.put(
        "run_1",
        "second.bin",
        new Uint8Array([2]),
        "application/octet-stream",
      ),
    ])).resolves.toHaveLength(2);

    expect(scans).toBe(1);
    expect(candidateChecks).toBe(1);
    await expect(first.get("artifact://run_1/first.bin"))
      .resolves.toEqual(new Uint8Array([1]));
    await expect(second.get("artifact://run_1/second.bin"))
      .resolves.toEqual(new Uint8Array([2]));
  });

  it("skips a stale candidate replaced during concurrent maintenance", async () => {
    const root = await temporaryRoot();
    const now = 100_000;
    const stale = join(root, ".artifact-tmp-999999-1000-ABC123");
    const displaced = join(root, "displaced-stale");
    await mkdir(stale);
    await utimes(stale, 1, 1);
    let candidateChecks = 0;
    const hooks: LocalArtifactStoreTestHooks = {
      now: () => now,
      staleStagingAgeMs: 10_000,
      stagingMaintenanceIntervalMs: 5_000,
      isProcessAlive: () => false,
      async afterStaleCandidateLstat(path) {
        candidateChecks += 1;
        await rename(path, displaced);
        await mkdir(path);
        await utimes(path, now / 1_000, now / 1_000);
      },
    };
    const first = storeWithHooks(root, hooks);
    const second = storeWithHooks(root, hooks);

    await expect(Promise.all([
      first.put(
        "run_1",
        "first-replacement.bin",
        new Uint8Array([1]),
        "application/octet-stream",
      ),
      second.put(
        "run_1",
        "second-replacement.bin",
        new Uint8Array([2]),
        "application/octet-stream",
      ),
    ])).resolves.toHaveLength(2);

    expect(candidateChecks).toBe(1);
    expect((await lstat(stale)).isDirectory()).toBe(true);
    expect((await lstat(displaced)).isDirectory()).toBe(true);
  });

  it("throttles maintenance across stores and rescans after the interval", async () => {
    const root = await temporaryRoot();
    let now = 100_000;
    let scans = 0;
    await Promise.all(Array.from({ length: 128 }, (_, index) =>
      mkdir(join(root, `artifact-seed-${index}`))
    ));
    const hooks: LocalArtifactStoreTestHooks = {
      now: () => now,
      staleStagingAgeMs: 10_000,
      stagingMaintenanceIntervalMs: 5_000,
      isProcessAlive: () => false,
      onStagingScan: () => {
        scans += 1;
      },
    };
    const first = storeWithHooks(root, hooks);
    const second = storeWithHooks(root, hooks);

    for (let index = 0; index < 64; index += 1) {
      const store = index % 2 === 0 ? first : second;
      await store.put(
        "run_1",
        `batch-${index}.bin`,
        new Uint8Array([index]),
        "application/octet-stream",
      );
    }
    await first.put(
      "run_1",
      "batch-0.bin",
      new Uint8Array([0]),
      "application/octet-stream",
    );
    expect(scans).toBe(1);

    const stale = join(root, ".artifact-tmp-999999-1000-ABC123");
    await mkdir(stale);
    await utimes(stale, 1, 1);
    now += 4_999;
    await second.put(
      "run_1",
      "before-interval.bin",
      new Uint8Array([1]),
      "application/octet-stream",
    );
    expect(scans).toBe(1);
    expect((await lstat(stale)).isDirectory()).toBe(true);

    now += 1;
    await first.put(
      "run_1",
      "after-interval.bin",
      new Uint8Array([2]),
      "application/octet-stream",
    );
    expect(scans).toBe(2);
    await expect(lstat(stale).catch(() => null)).resolves.toBeNull();
  });

  it("never returns external bytes after an object directory replacement", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const seed = new LocalArtifactStore(root);
    const trustedBody = new Uint8Array([1, 2, 3]);
    const externalBody = new Uint8Array([9, 8, 7]);
    await seed.put(
      "run_1",
      "report.bin",
      trustedBody,
      "application/octet-stream",
    );
    const physicalObjectName = objectName("run_1", "report.bin");
    await writeArtifactObject(
      join(outside, physicalObjectName),
      "artifact://run_1/report.bin",
      externalBody,
    );

    let replaced = false;
    const store = storeWithHooks(root, {
      async afterObjectSnapshot() {
        if (replaced) return;
        replaced = true;
        await rename(
          join(root, physicalObjectName),
          join(root, "object-displaced"),
        );
        await symlink(
          join(outside, physicalObjectName),
          join(root, physicalObjectName),
          "dir",
        );
      },
    });

    await expect(
      store.get("artifact://run_1/report.bin"),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_UNSAFE" });
  });
});
