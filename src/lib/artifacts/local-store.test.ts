import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
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

  it("anchors publication to root when the logical run path changes", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(join(root, "run_1"));
    let replaced = false;
    const store = storeWithHooks(root, {
      async beforePublishRename() {
        if (replaced) return;
        replaced = true;
        await rename(join(root, "run_1"), join(root, "run_displaced"));
        await symlink(outside, join(root, "run_1"), "dir");
      },
    });

    await expect(
      store.put(
        "run_1",
        "report.bin",
        new Uint8Array([4, 5, 6]),
        "application/octet-stream",
      ),
    ).resolves.toMatchObject({
      uri: "artifact://run_1/report.bin",
    });

    await expect(readdir(outside)).resolves.toEqual([]);
    await expect(
      store.get("artifact://run_1/report.bin"),
    ).resolves.toEqual(new Uint8Array([4, 5, 6]));
    await expect(
      lstat(objectDirectory(root, "run_1", "report.bin")),
    ).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
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
