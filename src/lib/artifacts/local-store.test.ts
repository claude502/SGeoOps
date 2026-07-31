import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactStoreError,
  LocalArtifactStore,
} from "@/lib/artifacts/local-store";

const temporaryRoots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "sgeo-artifacts-"));
  temporaryRoots.push(root);
  return root;
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
      (await readdir(join(root, "run_1")))
        .filter((name) => name.startsWith(".artifact-tmp-")),
    ).toEqual([]);
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
    const objectDir = join(root, "run_1", "report.bin");

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

    await symlink(outside, join(root, "run_link"), "dir");
    await expect(
      store.put(
        "run_link",
        "report.json",
        new Uint8Array([1]),
        "application/json",
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_UNSAFE" });

    await mkdir(join(root, "run_1"));
    await symlink(outside, join(root, "run_1", "report.json"), "dir");
    await expect(
      store.get("artifact://run_1/report.json"),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_UNSAFE" });

    expect((await lstat(join(root, "run_link"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, "missing"), "utf8").catch(() => null))
      .toBeNull();
  });
});
