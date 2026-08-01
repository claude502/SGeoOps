import { readFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import * as ts from "typescript";

const projectRoot = process.cwd();
const bootstrapPath = "scripts/bootstrap-admin.ts";
const bootstrapStatusPath = "scripts/bootstrap-admin-status.ts";

function runnerStage(dockerfile: string) {
  const stage = dockerfile.split(/^FROM node:24-alpine AS runner$/m)[1];

  if (!stage) {
    throw new Error("Production runner stage is required.");
  }

  return stage;
}

function fencedBashBlockContaining(source: string, needle: string) {
  const needleIndex = source.indexOf(needle);
  const start = source.lastIndexOf("```bash\n", needleIndex);
  const end = source.indexOf("\n```", needleIndex);

  if (needleIndex === -1 || start === -1 || end === -1) {
    throw new Error(`Bash block containing ${needle} is required.`);
  }

  return source.slice(start + "```bash\n".length, end);
}

function localImportSpecifiers(source: string, filePath: string) {
  const parsed = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers = new Set<string>();

  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.add(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return [...specifiers];
}

function localSourceImportPath(importerPath: string, moduleSpecifier: string) {
  const sourceRoot = resolve(projectRoot, "src");
  const importedSource = moduleSpecifier.startsWith("@/")
    ? resolve(sourceRoot, moduleSpecifier.slice(2))
    : moduleSpecifier.startsWith(".")
      ? resolve(dirname(resolve(projectRoot, importerPath)), moduleSpecifier)
      : null;

  return importedSource
    ? `${normalize(relative(projectRoot, importedSource))}.ts`
    : null;
}

async function localSourceClosure(entryPaths: string[]) {
  const pending = [...entryPaths];
  const discovered = new Set<string>();

  while (pending.length > 0) {
    const sourcePath = pending.pop();

    if (!sourcePath || discovered.has(sourcePath)) {
      continue;
    }

    discovered.add(sourcePath);
    const source = await readFile(resolve(projectRoot, sourcePath), "utf8");

    for (const moduleSpecifier of localImportSpecifiers(source, sourcePath)) {
      const importedPath = localSourceImportPath(sourcePath, moduleSpecifier);

      if (importedPath && !discovered.has(importedPath)) {
        pending.push(importedPath);
      }
    }
  }

  return [...discovered].sort();
}

function bashBlockAfterHeading(source: string, heading: string) {
  const headingIndex = source.indexOf(heading);
  const start = source.indexOf("```bash\n", headingIndex);
  const end = source.indexOf("\n```", start);

  if (headingIndex === -1 || start === -1 || end === -1) {
    throw new Error(`Bash block after ${heading} is required.`);
  }

  return source.slice(start + "```bash\n".length, end);
}

describe("production bootstrap runtime", () => {
  it("discovers local module re-exports in the runner source closure", () => {
    expect(
      localImportSpecifiers(
        'export { bootstrap } from "./bootstrap"; export * from "@/lib/prisma";',
        "scripts/entrypoint.ts",
      ),
    ).toEqual(["./bootstrap", "@/lib/prisma"]);
  });

  it("copies every local bootstrap runtime dependency, tsconfig, and tsx into the runner", async () => {
    const [dockerfile, packageJson, sourceClosure] = await Promise.all([
      readFile(resolve(projectRoot, "Dockerfile"), "utf8"),
      readFile(resolve(projectRoot, "package.json"), "utf8"),
      localSourceClosure([bootstrapPath, bootstrapStatusPath]),
    ]);
    const packageManifest = JSON.parse(packageJson) as {
      scripts: Record<string, string | undefined>;
      dependencies: Record<string, string | undefined>;
    };
    const runner = runnerStage(dockerfile);

    expect(packageManifest.scripts["auth:bootstrap"]).toBe(
      "tsx scripts/bootstrap-admin.ts",
    );
    expect(packageManifest.scripts["auth:bootstrap:status"]).toBe(
      "tsx scripts/bootstrap-admin-status.ts",
    );
    expect(packageManifest.dependencies.tsx).toBeDefined();
    expect(runner).toContain(
      "COPY --from=builder /app/node_modules ./node_modules",
    );
    expect(runner).toContain(
      "COPY --from=builder /app/tsconfig.json ./tsconfig.json",
    );

    for (const sourcePath of sourceClosure) {
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

  it("keeps active rollout documentation on the first-admin Better Auth procedure", async () => {
    const [deploymentGuide, geoFlowRollout, trendReview] = await Promise.all([
      readFile(
        resolve(projectRoot, "docs/server-47.239.166.249-deployment.md"),
        "utf8",
      ),
      readFile(resolve(projectRoot, "docs/geoflow-rollout.md"), "utf8"),
      readFile(
        resolve(projectRoot, "docs/geo-seo-trend-engine-review.md"),
        "utf8",
      ),
    ]);
    const migration = deploymentGuide.indexOf("npm run prisma:deploy");
    const bootstrap = deploymentGuide.indexOf("geo-ops npm run auth:bootstrap");
    const verification = deploymentGuide.indexOf("### 7. 验证");
    const startupProcedure = bashBlockAfterHeading(
      deploymentGuide,
      "### 6. 启动服务",
    );
    const procedureMigration = startupProcedure.indexOf("npm run prisma:deploy");
    const procedureBootstrap = startupProcedure.indexOf(
      "geo-ops npm run auth:bootstrap",
    );
    const cleanup = startupProcedure.indexOf(
      "cleanup_bootstrap_env\ntrap - EXIT",
    );
    const fullStackStart = [
      ...startupProcedure.matchAll(
        /^docker compose --env-file \.env -f deploy\/docker-compose\.prod\.example\.yml up -d$/gm,
      ),
    ].at(-1)?.index ?? -1;

    expect(migration).toBeGreaterThanOrEqual(0);
    expect(bootstrap).toBeGreaterThan(migration);
    expect(bootstrap).toBeLessThan(verification);
    expect(deploymentGuide).toContain(
      "docker compose --env-file .env -f deploy/docker-compose.prod.example.yml run --rm \\",
    );
    expect(deploymentGuide).toContain(
      "read -r -s -p 'Admin password: ' SGEO_BOOTSTRAP_ADMIN_PASSWORD",
    );
    expect(deploymentGuide).toContain(
      "unset SGEO_BOOTSTRAP_ADMIN_EMAIL SGEO_BOOTSTRAP_ADMIN_NAME SGEO_BOOTSTRAP_ADMIN_PASSWORD",
    );
    expect(startupProcedure).toContain("set -euo pipefail");
    expect(startupProcedure).toContain("trap cleanup_bootstrap_env EXIT");
    expect(procedureMigration).toBeGreaterThanOrEqual(0);
    expect(procedureBootstrap).toBeGreaterThan(procedureMigration);
    expect(cleanup).toBeGreaterThan(procedureBootstrap);
    expect(fullStackStart).toBeGreaterThan(cleanup);

    expect(geoFlowRollout).toContain("BETTER_AUTH_SECRET=");
    expect(geoFlowRollout).toContain("BETTER_AUTH_URL=");
    expect(geoFlowRollout).toContain("Better Auth session");
    expect(geoFlowRollout).not.toMatch(/GEO_OPS_(?:AUTH|ADMIN)_/);

    expect(trendReview).toContain("Better Auth session");
    expect(trendReview).toContain("membership role and client scope");
    expect(trendReview).not.toContain("x-geo-ops-action: true");
    expect(trendReview).not.toContain("Basic Auth protected dashboard");
  });

  it("gates every active production entrypoint on a verified Administrator before full startup", async () => {
    const [readme, deployReadme, geoFlowRollout, remoteDeploy] = await Promise.all([
      readFile(resolve(projectRoot, "README.md"), "utf8"),
      readFile(resolve(projectRoot, "deploy/README.md"), "utf8"),
      readFile(resolve(projectRoot, "docs/geoflow-rollout.md"), "utf8"),
      readFile(resolve(projectRoot, "deploy/remote-deploy.ps1"), "utf8"),
    ]);

    for (const deploymentGuide of [readme, deployReadme]) {
      const firstDeployment = fencedBashBlockContaining(
        deploymentGuide,
        "geo-ops npm run auth:bootstrap",
      );
      const bootstrap = firstDeployment.indexOf("geo-ops npm run auth:bootstrap");
      const status = firstDeployment.indexOf(
        "geo-ops npm run auth:bootstrap:status",
      );
      const fullStackStart = [
        ...firstDeployment.matchAll(
          /^docker compose --env-file \.env -f deploy\/docker-compose\.prod\.example\.yml up -d$/gm,
        ),
      ].at(-1)?.index ?? -1;

      expect(firstDeployment).toContain("set -euo pipefail");
      expect(firstDeployment).toContain(
        "read -r -s -p 'Admin password: ' SGEO_BOOTSTRAP_ADMIN_PASSWORD",
      );
      expect(firstDeployment).toContain("trap cleanup_bootstrap_env EXIT");
      expect(bootstrap).toBeGreaterThanOrEqual(0);
      expect(status).toBeGreaterThan(bootstrap);
      expect(fullStackStart).toBeGreaterThan(status);
    }

    const geoFlowGate = fencedBashBlockContaining(
      geoFlowRollout,
      "geo-ops npm run auth:bootstrap:status",
    );
    const geoFlowStatus = geoFlowGate.indexOf(
      "geo-ops npm run auth:bootstrap:status",
    );
    const geoFlowFullStackStart = geoFlowGate.indexOf(
      "docker compose --env-file .env -f deploy/docker-compose.prod.example.yml up -d",
    );

    expect(geoFlowGate).toContain("set -euo pipefail");
    expect(geoFlowStatus).toBeGreaterThanOrEqual(0);
    expect(geoFlowFullStackStart).toBeGreaterThan(geoFlowStatus);

    const migration = remoteDeploy.indexOf("npm run prisma:deploy");
    const status = remoteDeploy.indexOf("npm run auth:bootstrap:status");
    const fullStackStart = remoteDeploy.indexOf(
      '$remoteCommands += "docker compose --env-file .env -f deploy/docker-compose.prod.example.yml up -d"',
    );

    expect(migration).toBeGreaterThanOrEqual(0);
    expect(status).toBeGreaterThan(migration);
    expect(fullStackStart).toBeGreaterThan(status);
    expect(remoteDeploy).toContain('($remoteCommands -join " && ")');
    expect(remoteDeploy).not.toMatch(/SGEO_BOOTSTRAP_ADMIN_/);
  });

  it("propagates every native deployment command failure, including the final status gate", async () => {
    const remoteDeploy = await readFile(
      resolve(projectRoot, "deploy/remote-deploy.ps1"),
      "utf8",
    );
    const nativeOperations = [
      ["Create deployment archive", "tar"],
      ["Create remote deployment directory", "ssh"],
      ["Upload deployment archive", "scp"],
      ["Extract deployment archive", "ssh"],
      ["Run remote deployment", "ssh"],
    ];

    expect(remoteDeploy).toMatch(
      /function Invoke-NativeCommand[\s\S]*?& \$Command[\s\S]*?\$exitCode = \$LASTEXITCODE[\s\S]*?if \(\$exitCode -ne 0\)[\s\S]*?throw "\$Operation failed with exit code \$exitCode\./,
    );
    expect(remoteDeploy).toMatch(
      /try \{[\s\S]*?& \$Command[\s\S]*?\}\s*catch \{[\s\S]*?throw "\$Operation failed: \$\(\$_\.Exception\.Message\)"/,
    );
    expect(remoteDeploy).not.toContain("Invoke-Expression");

    for (const [operation, command] of nativeOperations) {
      expect(remoteDeploy).toMatch(
        new RegExp(
          `Invoke-NativeCommand -Operation "${operation}" -Command \\{[\\s\\S]*?\\b${command}\\b`,
        ),
      );
    }

    expect(remoteDeploy).toMatch(
      /Invoke-NativeCommand -Operation "Run remote deployment" -Command \{[\s\S]*?ssh -i \$KeyPath \$remote \(\$remoteCommands -join " && "\)/,
    );
  });
});
