import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const directDatabaseCredentialPattern =
  /\b(?:DATABASE_URL(?:_FILE)?|POSTGRES(?:_[A-Z_]+)?|PG(?:HOST|PORT|USER|PASSWORD|DATABASE)|PRISMA_DATABASE_URL(?:_FILE))\b/;

type RenderedCompose = {
  services: Record<
    string,
    {
      environment?: Record<string, string>;
    }
  >;
};

function serviceBlock(compose: string, serviceName: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);

  if (start === -1) {
    throw new Error(`Compose service ${serviceName} was not found.`);
  }

  const end = lines.findIndex(
    (line, index) => index > start && /^(?:  [A-Za-z0-9_-]+:|[A-Za-z0-9_-]+:)/.test(line),
  );

  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function markdownSection(document: string, heading: string): string {
  const start = document.indexOf(heading);
  if (start === -1) throw new Error(`Missing documentation section: ${heading}`);
  const nextHeading = document.indexOf("\n## ", start + heading.length);
  return document.slice(start, nextHeading === -1 ? undefined : nextHeading);
}

function publishesPort(compose: string, port: number): boolean {
  const shortSyntax = new RegExp(
    `^\\s*-\\s*["']?(?:[0-9.]+:)?${port}:${port}["']?\\s*$`,
    "m",
  );
  const longSyntax = new RegExp(
    `target:\\s*["']?${port}["']?[\\s\\S]{0,160}?published:\\s*["']?${port}["']?`,
    "m",
  );

  return shortSyntax.test(compose) || longSyntax.test(compose);
}

async function renderProductionComposeWithFixture(): Promise<RenderedCompose> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "sgeo-compose-policy-"));
  const fixtureDeploy = join(fixtureRoot, "deploy");
  const fixtureEnv = join(fixtureRoot, ".env");

  try {
    await mkdir(fixtureDeploy);
    await writeFile(
      join(fixtureDeploy, "docker-compose.prod.example.yml"),
      await readFile(
        resolve(process.cwd(), "deploy/docker-compose.prod.example.yml"),
        "utf8",
      ),
    );
    await writeFile(
      fixtureEnv,
      [
        "DATABASE_URL=postgresql://geo_ops:fixture-postgres-password@postgres:5432/geo_content_ops?schema=public",
        "BETTER_AUTH_SECRET=fixture-better-auth-secret",
        "POSTGRES_PASSWORD=fixture-postgres-password",
      ].join("\n"),
    );

    const { stdout } = await execFileAsync(
      "docker",
      [
        "compose",
        "--env-file",
        fixtureEnv,
        "-f",
        join(fixtureDeploy, "docker-compose.prod.example.yml"),
        "config",
        "--format",
        "json",
      ],
      { cwd: fixtureRoot },
    );

    return JSON.parse(stdout) as RenderedCompose;
  } finally {
    await rm(fixtureRoot, { recursive: true });
  }
}

async function renderDevelopmentComposeWithFixture(): Promise<RenderedCompose> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "sgeo-compose-policy-"));
  const fixtureEnv = join(fixtureRoot, ".env");

  try {
    await writeFile(
      join(fixtureRoot, "docker-compose.yml"),
      await readFile(resolve(process.cwd(), "docker-compose.yml"), "utf8"),
    );
    await writeFile(
      fixtureEnv,
      "TRIGGER_ACCESS_TOKEN=fixture-trigger-access-token\n",
    );

    const { stdout } = await execFileAsync(
      "docker",
      [
        "compose",
        "--env-file",
        fixtureEnv,
        "-f",
        join(fixtureRoot, "docker-compose.yml"),
        "config",
        "--format",
        "json",
      ],
      { cwd: fixtureRoot },
    );

    return JSON.parse(stdout) as RenderedCompose;
  } finally {
    await rm(fixtureRoot, { recursive: true });
  }
}

describe("Compose worker isolation policy", () => {
  it("keeps the development geo-worker free of direct database configuration", async () => {
    const composePath = "docker-compose.yml";
    const compose = await readFile(resolve(process.cwd(), composePath), "utf8");
    const worker = serviceBlock(compose, "geo-worker");

    expect(worker, composePath).not.toMatch(directDatabaseCredentialPattern);
    expect(worker, composePath).not.toMatch(/\b(?:postgres|postgresql):\/\//i);
    expect(worker, composePath).not.toMatch(/^\s+env_file:/m);
    expect(worker, composePath).toContain("SGEO_INTERNAL_URL");
    expect(worker, composePath).toContain("SGEO_INTERNAL_SECRET_FILE");
  });

  it("keeps Trigger v4 dev lifecycle out of the production SGeoOps stack", async () => {
    const [development, production, readme, workerDockerfile] = await Promise.all([
      readFile(resolve(process.cwd(), "docker-compose.yml"), "utf8"),
      readFile(
        resolve(process.cwd(), "deploy/docker-compose.prod.example.yml"),
        "utf8",
      ),
      readFile(resolve(process.cwd(), "deploy/README.md"), "utf8"),
      readFile(resolve(process.cwd(), "geo-worker/Dockerfile"), "utf8"),
    ]);
    const developmentWorker = serviceBlock(development, "geo-worker");

    expect(development).toContain(
      "image: ghcr.io/triggerdotdev/trigger.dev:v4.5.9",
    );
    expect(developmentWorker).toContain(
      'command: ["npm", "run", "trigger:dev"]',
    );
    expect(developmentWorker).toContain(
      "TRIGGER_ACCESS_TOKEN=${TRIGGER_ACCESS_TOKEN:-}",
    );
    expect(production).not.toContain("\n  geo-worker:");
    expect(production).not.toContain("TRIGGER_ACCESS_TOKEN");
    expect(production).not.toContain("TRIGGER_API_KEY");
    expect(workerDockerfile).not.toMatch(/^CMD\s/m);
    expect(readme).toContain("Trigger.dev v4.5.9");
    expect(readme).toContain("Phase 2 Task 9");
    expect(readme).toContain("`TRIGGER_API_URL` and `TRIGGER_ACCESS_TOKEN`");
  });

  it("keeps current restore procedures inside the production Compose boundary", async () => {
    const [sop, reference] = await Promise.all([
      readFile(resolve(process.cwd(), "docs/system-sop.md"), "utf8"),
      readFile(resolve(process.cwd(), "docs/system-reference.md"), "utf8"),
    ]);
    const restoreSop = markdownSection(sop, "### 9.4 PostgreSQL、artifact 与应用回退");
    const restoreReference = markdownSection(reference, "### 11.5 恢复 PostgreSQL 与 artifacts");

    for (const procedure of [restoreSop, restoreReference]) {
      expect(procedure).not.toMatch(/\bup\s+-d\s+geo-worker\b/);
      expect(procedure).not.toMatch(/\bstop\s+geo-worker\b/);
      expect(procedure).not.toMatch(/\bps\s+(?:--[^\n]+\s+)?geo-worker\b/);
      expect(procedure).not.toMatch(/\blogs(?:\s+--tail\s+\d+)?\s+geo-worker\b/);
      expect(procedure).toContain("../deploy/README.md#triggerdev-v4-production-precondition");
      expect(procedure).toContain("Phase 2 Task 9");
    }
  });

  it("does not publish PostgreSQL or Redis from production Compose", async () => {
    const compose = await readFile(
      resolve(process.cwd(), "deploy/docker-compose.prod.example.yml"),
      "utf8",
    );

    expect(publishesPort(compose, 5432)).toBe(false);
    expect(publishesPort(compose, 6379)).toBe(false);
  });

  it("allows production Compose to render before operators provide runtime env", async () => {
    const compose = await readFile(
      resolve(process.cwd(), "deploy/docker-compose.prod.example.yml"),
      "utf8",
    );

    expect(compose).toMatch(
      /env_file:\n\s+- path: \.\.\/\.env\n\s+required: false/,
    );
  });

  it("does not provide a production database password fallback", async () => {
    const compose = await readFile(
      resolve(process.cwd(), "deploy/docker-compose.prod.example.yml"),
      "utf8",
    );

    expect(compose).toContain("POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-}");
  });

  it("treats database URL file variables as direct worker database credentials", () => {
    expect("DATABASE_URL_FILE=/run/secrets/database_url").toMatch(
      directDatabaseCredentialPattern,
    );
    expect("PRISMA_DATABASE_URL_FILE=/run/secrets/database_url").toMatch(
      directDatabaseCredentialPattern,
    );
  });

  it("keeps secrets out of root Docker builds and deployment archives", async () => {
    const [dockerignore, remoteDeploy] = await Promise.all([
      readFile(resolve(process.cwd(), ".dockerignore"), "utf8"),
      readFile(resolve(process.cwd(), "deploy/remote-deploy.ps1"), "utf8"),
    ]);

    expect(dockerignore).toMatch(/^secrets\/$/m);
    expect(remoteDeploy).toContain('--exclude="secrets/"');
    expect(remoteDeploy).toContain("test -f secrets/sgeo_internal_secret");
  });

  it("renders production service configuration from an explicit fixture env file", async () => {
    const rendered = await renderProductionComposeWithFixture();
    const postgres = rendered.services.postgres.environment ?? {};
    const ops = rendered.services["geo-ops"].environment ?? {};

    expect(postgres.POSTGRES_PASSWORD).toBe("fixture-postgres-password");
    expect(ops.DATABASE_URL).toBe(
      "postgresql://geo_ops:fixture-postgres-password@postgres:5432/geo_content_ops?schema=public",
    );
    expect(ops.BETTER_AUTH_SECRET).toBe("fixture-better-auth-secret");
    expect(rendered.services).not.toHaveProperty("geo-worker");
    expect(JSON.stringify(rendered)).not.toContain("TRIGGER_ACCESS_TOKEN");
    expect(JSON.stringify(rendered)).not.toContain("TRIGGER_API_KEY");
  });

  it("renders the v4 access-token contract into the development worker only", async () => {
    const rendered = await renderDevelopmentComposeWithFixture();
    const worker = rendered.services["geo-worker"].environment ?? {};

    expect(worker.TRIGGER_ACCESS_TOKEN).toBe("fixture-trigger-access-token");
    expect(worker).not.toHaveProperty("TRIGGER_API_KEY");
  });

  it("uses root .env for production Compose interpolation in documentation and remote deploys", async () => {
    const [readme, remoteDeploy] = await Promise.all([
      readFile(resolve(process.cwd(), "README.md"), "utf8"),
      readFile(resolve(process.cwd(), "deploy/remote-deploy.ps1"), "utf8"),
    ]);

    expect(readme).toContain(
      "docker compose --env-file .env -f deploy/docker-compose.prod.example.yml build",
    );
    expect(remoteDeploy).toContain(
      "docker compose --env-file .env -f deploy/docker-compose.prod.example.yml build",
    );
    expect(remoteDeploy).not.toContain(
      "docker compose -f deploy/docker-compose.prod.example.yml",
    );
  });
});
