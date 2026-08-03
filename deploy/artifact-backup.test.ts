import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(process.cwd(), "deploy/backup-artifacts.sh");

describe("artifact backup script", () => {
  it("is syntax-valid and retains the artifact archive safety contract", async () => {
    const [script] = await Promise.all([
      readFile(scriptPath, "utf8"),
      execFileAsync("bash", ["-n", scriptPath]),
    ]);

    expect(script).toContain("set -Eeuo pipefail");
    expect(script).toContain("umask 077");
    expect(script).toContain("SGEO_ARTIFACT_BACKUP_DIR");
    expect(script).toContain("SGEO_ARTIFACT_ROOT");
    expect(script).toContain("docker compose");
    expect(script).toContain("gzip -t");
    expect(script).toContain("tar -tzf");
    expect(script).toContain("ARTIFACT_BACKUP_RETENTION_DAYS");
  });
});
