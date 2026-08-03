import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { InternalSgeoAuthError, readInternalSgeoSecret } from "./internal-sgeo-auth";

describe("readInternalSgeoSecret", () => {
  it("reads the configured secret file ahead of the optional task-secret environment variable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sgeo-internal-auth-"));
    const secretFile = join(directory, "internal-secret");
    await writeFile(secretFile, "file-secret\n", { mode: 0o600 });

    try {
      await expect(readInternalSgeoSecret({
        SGEO_INTERNAL_SECRET_FILE: secretFile,
        SGEO_INTERNAL_SECRET: "environment-secret",
      })).resolves.toBe("file-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts a non-empty Trigger Secret environment variable when no file mount exists", async () => {
    await expect(readInternalSgeoSecret({ SGEO_INTERNAL_SECRET: "environment-secret\n" }))
      .resolves.toBe("environment-secret");
  });

  it("fails closed for unreadable or empty configured files and never falls back to another value", async () => {
    await expect(readInternalSgeoSecret({
      SGEO_INTERNAL_SECRET_FILE: "/does-not-exist/internal-secret",
      SGEO_INTERNAL_SECRET: "environment-secret",
    })).rejects.toEqual(expect.objectContaining({
      name: "InternalSgeoAuthError",
      code: "secret_file_unreadable",
    }));

    await expect(readInternalSgeoSecret({ SGEO_INTERNAL_SECRET: " \n" }))
      .rejects.toBeInstanceOf(InternalSgeoAuthError);
  });
});
