import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

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

describe("Compose worker isolation policy", () => {
  it("does not give geo-worker direct database configuration", async () => {
    for (const composePath of [
      "docker-compose.yml",
      "deploy/docker-compose.prod.example.yml",
    ]) {
      const compose = await readFile(resolve(process.cwd(), composePath), "utf8");
      const worker = serviceBlock(compose, "geo-worker");

      expect(worker, composePath).not.toMatch(
        /\b(?:DATABASE_URL|POSTGRES(?:_[A-Z_]+)?|PG(?:HOST|PORT|USER|PASSWORD|DATABASE)|PRISMA_DATABASE_URL)\b/,
      );
      expect(worker, composePath).not.toMatch(/\b(?:postgres|postgresql):\/\//i);
      expect(worker, composePath).not.toMatch(/^\s+env_file:/m);
      expect(worker, composePath).toContain("SGEO_INTERNAL_URL");
      expect(worker, composePath).toContain("SGEO_INTERNAL_SECRET_FILE");
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
});
