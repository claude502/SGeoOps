import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import config from "../trigger.config";

const rootFile = (path: string) => new URL(`../../${path}`, import.meta.url);

describe("Trigger v4 worker configuration", () => {
  it("uses the approved project and bounded default retry policy", () => {
    expect(config.project).toBe(
      process.env.TRIGGER_PROJECT_REF ?? "proj_sgeo_ops",
    );
    expect(config.dirs).toEqual(["./src/tasks"]);
    expect(config.retries).toEqual({
      enabledInDev: false,
      default: {
        maxAttempts: 3,
        minTimeoutInMs: 1_000,
        maxTimeoutInMs: 30_000,
        factor: 2,
      },
    });
  });

  it("injects the v4 access-token contract into the development worker service", async () => {
    const [development, environmentExample] = await Promise.all([
      readFile(rootFile("docker-compose.yml"), "utf8"),
      readFile(rootFile(".env.example"), "utf8"),
    ]);

    expect(development).toContain(
      "- TRIGGER_ACCESS_TOKEN=${TRIGGER_ACCESS_TOKEN:-}",
    );
    expect(environmentExample).toContain("TRIGGER_ACCESS_TOKEN=");
    expect(development).not.toContain("TRIGGER_API_KEY=");
    expect(environmentExample).not.toContain("TRIGGER_WORKER_API_KEY=");
  });

  it("keeps the production runner contract API-only and version-pinned", async () => {
    const [environmentExample, runbook] = await Promise.all([
      readFile(rootFile("deploy/trigger.env.example"), "utf8"),
      readFile(rootFile("deploy/trigger/README.md"), "utf8"),
    ]);

    expect(environmentExample).toContain("SGEO_INTERNAL_SECRET=");
    expect(environmentExample).toContain("SGEO_INTERNAL_SECRET_FILE=/run/secrets/sgeo_internal_secret");
    expect(environmentExample).toContain("Never configure DATABASE_URL");
    expect(runbook).toContain("v4.5.9");
    expect(runbook).toContain("TRIGGER_ACCESS_TOKEN");
    expect(runbook).toContain("does not start Trigger workers");
  });

  it("prevents plain TypeScript compilation from emitting into worker source", async () => {
    const tsconfig = JSON.parse(
      await readFile(rootFile("geo-worker/tsconfig.json"), "utf8"),
    ) as { compilerOptions?: { noEmit?: boolean } };

    expect(tsconfig.compilerOptions?.noEmit).toBe(true);
  });
});
