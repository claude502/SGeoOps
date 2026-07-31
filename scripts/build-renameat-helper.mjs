import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repositoryRoot, "native", "renameat-helper.c");
const outputDirectory = join(repositoryRoot, ".sgeo-native");
const output = join(outputDirectory, "sgeo-renameat-helper");
const temporaryOutput = join(
  outputDirectory,
  `.sgeo-renameat-helper-${randomUUID()}`,
);

if (process.platform !== "darwin" && process.platform !== "linux") {
  await rm(output, { force: true });
  console.warn(
    `renameat helper is unsupported on ${process.platform}; artifact publication will fail closed`,
  );
  process.exit(0);
}

const compiler = process.env.CC?.trim() || "cc";
if (compiler.includes("\0")) {
  throw new Error("CC contains an invalid NUL byte");
}

await mkdir(outputDirectory, { recursive: true, mode: 0o755 });
try {
  await new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(
      compiler,
      [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        source,
        "-o",
        temporaryOutput,
      ],
      { shell: false, stdio: "inherit" },
    );
    child.once("error", rejectBuild);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveBuild();
        return;
      }
      rejectBuild(
        new Error(
          `renameat helper compiler exited with ${
            code ?? `signal ${signal ?? "unknown"}`
          }`,
        ),
      );
    });
  });
  await chmod(temporaryOutput, 0o755);
  await rename(temporaryOutput, output);
} finally {
  await rm(temporaryOutput, { force: true });
}
