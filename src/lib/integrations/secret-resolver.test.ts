import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileSecretResolver } from "@/lib/integrations/secret-resolver";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("FileSecretResolver", () => {
  it("requires SGEO_SECRET_ROOT", async () => {
    const resolver = new FileSecretResolver({});
    await expect(resolver.resolve("file:token")).rejects.toThrow(
      "SGEO_SECRET_ROOT_REQUIRED",
    );
  });

  it("reads a regular file and removes exactly one LF or CRLF", async () => {
    const root = await temporaryDirectory("sgeo-secret-root-");
    await writeFile(join(root, "lf"), " secret \n");
    await writeFile(join(root, "crlf"), "secret\r\n");
    await writeFile(join(root, "double"), "secret\n\n");
    const resolver = new FileSecretResolver({ SGEO_SECRET_ROOT: root });

    await expect(resolver.resolve("file:lf")).resolves.toBe(" secret ");
    await expect(resolver.resolve("file:crlf")).resolves.toBe("secret");
    await expect(resolver.resolve("file:double")).resolves.toBe("secret\n");
  });

  it.each([
    "file:../token",
    "file:nested/../../token",
    "file:/absolute/token",
    "file:\u0000token",
    "env:API_TOKEN",
  ])("rejects unsafe references: %s", async (reference) => {
    const root = await temporaryDirectory("sgeo-secret-root-");
    const resolver = new FileSecretResolver({ SGEO_SECRET_ROOT: root });

    await expect(resolver.resolve(reference as never)).rejects.toThrow();
  });

  it("rejects a prefix sibling and an outside-root symlink", async () => {
    const parent = await temporaryDirectory("sgeo-secret-parent-");
    const root = join(parent, "secrets");
    const sibling = join(parent, "secrets-copy");
    await mkdir(root);
    await mkdir(sibling);
    await writeFile(join(sibling, "token"), "outside");
    await symlink(join(sibling, "token"), join(root, "outside-link"));
    const resolver = new FileSecretResolver({ SGEO_SECRET_ROOT: root });

    await expect(resolver.resolve("file:../secrets-copy/token")).rejects.toThrow(
      "SECRET_REFERENCE_INVALID",
    );
    await expect(resolver.resolve("file:outside-link")).rejects.toThrow(
      "SECRET_OUTSIDE_ROOT",
    );
  });

  it("allows a symlink whose resolved regular file remains inside the root", async () => {
    const root = await temporaryDirectory("sgeo-secret-root-");
    await mkdir(join(root, "actual"));
    await writeFile(join(root, "actual", "token"), "inside\n");
    await symlink(join(root, "actual", "token"), join(root, "token-link"));
    const resolver = new FileSecretResolver({ SGEO_SECRET_ROOT: root });

    await expect(resolver.resolve("file:token-link")).resolves.toBe("inside");
  });

  it("rejects missing paths and directories", async () => {
    const root = await temporaryDirectory("sgeo-secret-root-");
    await mkdir(join(root, "directory"));
    const resolver = new FileSecretResolver({ SGEO_SECRET_ROOT: root });

    await expect(resolver.resolve("file:missing")).rejects.toThrow(
      "SECRET_NOT_FOUND",
    );
    await expect(resolver.resolve("file:directory")).rejects.toThrow(
      "SECRET_NOT_REGULAR_FILE",
    );
  });
});
