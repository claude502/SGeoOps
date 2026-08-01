import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const bootstrapPath = "scripts/bootstrap-admin.ts";

function runnerStage(dockerfile: string) {
  const stage = dockerfile.split(/^FROM node:24-alpine AS runner$/m)[1];

  if (!stage) {
    throw new Error("Production runner stage is required.");
  }

  return stage;
}

function sourceImportPath(moduleSpecifier: string) {
  return `${normalize(join(dirname(bootstrapPath), moduleSpecifier))}.ts`;
}

describe("production bootstrap runtime", () => {
  it("copies the bootstrap script, its source imports, tsconfig, and tsx runtime into the runner", async () => {
    const [dockerfile, packageJson, bootstrapScript] = await Promise.all([
      readFile(resolve(projectRoot, "Dockerfile"), "utf8"),
      readFile(resolve(projectRoot, "package.json"), "utf8"),
      readFile(resolve(projectRoot, bootstrapPath), "utf8"),
    ]);
    const packageManifest = JSON.parse(packageJson) as {
      scripts: Record<string, string | undefined>;
      dependencies: Record<string, string | undefined>;
    };
    const imports = [
      ...bootstrapScript.matchAll(/import\("([^\"]+)"\)/g),
    ].map(([, moduleSpecifier]) => sourceImportPath(moduleSpecifier));
    const runner = runnerStage(dockerfile);

    expect(packageManifest.scripts["auth:bootstrap"]).toBe(
      "tsx scripts/bootstrap-admin.ts",
    );
    expect(packageManifest.dependencies.tsx).toBeDefined();
    expect(runner).toContain(
      "COPY --from=builder /app/node_modules ./node_modules",
    );
    expect(runner).toContain(
      "COPY --from=builder /app/tsconfig.json ./tsconfig.json",
    );
    expect(runner).toContain(
      "COPY --from=builder /app/scripts/bootstrap-admin.ts ./scripts/bootstrap-admin.ts",
    );

    for (const sourcePath of imports) {
      expect(runner).toContain(
        `COPY --from=builder /app/${sourcePath} ./${sourcePath}`,
      );
    }
  });

  it("keeps the documented bootstrap command pointed at the production geo-ops build", async () => {
    const [compose, systemReference] = await Promise.all([
      readFile(
        resolve(projectRoot, "deploy/docker-compose.prod.example.yml"),
        "utf8",
      ),
      readFile(resolve(projectRoot, "docs/system-reference.md"), "utf8"),
    ]);

    expect(compose).toMatch(
      /geo-ops:[\s\S]*?build:\s*\n\s*context: \.\.\s*\n\s*dockerfile: Dockerfile/,
    );
    expect(systemReference).toContain(
      "docker compose --env-file .env -f deploy/docker-compose.prod.example.yml run --rm \\",
    );
    expect(systemReference).toContain("geo-ops npm run auth:bootstrap");
  });
});
