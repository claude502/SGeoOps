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

  it("injects the v4 access-token contract into both worker compose services", async () => {
    const [development, production, environmentExample] = await Promise.all([
      readFile(rootFile("docker-compose.yml"), "utf8"),
      readFile(rootFile("deploy/docker-compose.prod.example.yml"), "utf8"),
      readFile(rootFile(".env.example"), "utf8"),
    ]);

    expect(development).toContain(
      "- TRIGGER_ACCESS_TOKEN=${TRIGGER_ACCESS_TOKEN:-}",
    );
    expect(production).toContain(
      "TRIGGER_ACCESS_TOKEN: ${TRIGGER_ACCESS_TOKEN:-}",
    );
    expect(environmentExample).toContain("TRIGGER_ACCESS_TOKEN=");
    expect(development).not.toContain("TRIGGER_API_KEY=");
    expect(production).not.toContain("TRIGGER_API_KEY:");
    expect(environmentExample).not.toContain("TRIGGER_WORKER_API_KEY=");
  });
});
