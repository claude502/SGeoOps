import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  beforeOpen: null as null | (() => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      await race.beforeOpen?.();
      return actual.open(...args);
    },
  };
});

import { FileSecretResolver } from "@/lib/integrations/secret-resolver";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  race.beforeOpen = null;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("FileSecretResolver adversarial races", () => {
  it("fails closed when an intermediate directory changes after realpath", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sgeo-secret-race-hook-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "root");
    const live = join(root, "live");
    const parked = join(root, "parked");
    const outside = join(parent, "outside");
    await mkdir(root);
    await mkdir(live);
    await mkdir(outside);
    await writeFile(join(live, "token"), "inside-secret\n");
    await writeFile(join(outside, "token"), "outside-secret\n");
    const resolver = new FileSecretResolver({ SGEO_SECRET_ROOT: root });
    let attacked = false;

    race.beforeOpen = async () => {
      if (attacked) return;
      attacked = true;
      await rename(live, parked);
      await symlink(outside, live);
    };

    try {
      await expect(resolver.resolve("file:live/token")).rejects.toThrow(
        "SECRET_IDENTITY_CHANGED",
      );
    } finally {
      if (attacked) {
        await unlink(live);
        await rename(parked, live);
      }
    }
  });
});
