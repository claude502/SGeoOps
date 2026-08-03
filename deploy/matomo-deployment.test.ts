import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

async function source(path: string) {
  return readFile(new URL(path, root), "utf8");
}

function service(compose: string, name: string) {
  const match = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:\\n|^networks:|^volumes:)`, "m")
    .exec(compose);
  if (match === null) throw new Error(`missing service ${name}`);
  return match[1]!;
}

describe("Matomo deployment isolation", () => {
  it.each(["docker-compose.yml", "deploy/docker-compose.prod.example.yml"])(
    "pins isolated healthy Matomo services in %s",
    async (path) => {
      const compose = await source(path);
      const database = service(compose, "matomo-db");
      const matomo = service(compose, "matomo");
      const archive = service(compose, "matomo-archive-cron");

      expect(database).toContain("image: mariadb:11.4.5");
      expect(database).not.toMatch(/\n    ports:/);
      expect(database).toContain("healthcheck:");
      expect(database).toContain("${MATOMO_DATABASE_PASSWORD:?set MATOMO_DATABASE_PASSWORD}");
      expect(database).toContain("${MATOMO_DATABASE_ROOT_PASSWORD:?set MATOMO_DATABASE_ROOT_PASSWORD}");

      expect(matomo).toContain("image: matomo:5.12.0-apache");
      expect(matomo).not.toMatch(/\n    ports:/);
      expect(matomo).toContain("condition: service_healthy");
      expect(matomo).toContain("healthcheck:");
      expect(matomo).toContain("matomo-private");
      expect(matomo).toContain("matomo-reporting");

      expect(archive).toContain("image: matomo:5.12.0-apache");
      expect(archive).toContain("sleep 3600");
      expect(archive).toContain("healthcheck:");
      expect(archive).toContain("matomo-private");
      expect(archive).not.toContain("matomo-reporting");
      expect(archive).not.toMatch(/(?:^|\s)- app(?:\s|$)/);
    },
  );

  it("keeps the production reverse proxy off the Matomo reporting network", async () => {
    const compose = await source("deploy/docker-compose.prod.example.yml");
    expect(service(compose, "reverse-proxy")).not.toContain("matomo-reporting");
    expect(service(compose, "geo-ops")).toContain("matomo-reporting");
  });

  it("exposes only Matomo tracking through a dedicated proxy network", async () => {
    const [compose, caddy, env, readme] = await Promise.all([
      source("deploy/docker-compose.prod.example.yml"),
      source("deploy/Caddyfile.example"),
      source(".env.example"),
      source("deploy/README.md"),
    ]);
    const proxy = service(compose, "reverse-proxy");
    const matomo = service(compose, "matomo");

    expect(proxy).toContain("matomo-tracking");
    expect(matomo).toContain("matomo-tracking");
    expect(service(compose, "geo-ops")).not.toContain("matomo-tracking");
    expect(service(compose, "matomo-db")).not.toContain("matomo-tracking");
    expect(proxy).not.toContain("matomo-reporting");
    expect(matomo).toContain("matomo-reporting");
    expect(compose).toMatch(/matomo-tracking:\n\s+internal: true/);

    expect(caddy).toContain("{$MATOMO_TRACKING_PUBLIC_HOST}");
    expect(caddy).toContain("path /matomo.php /matomo.js /piwik.php /piwik.js");
    expect(caddy).toMatch(/handle @matomo_tracking \{\s*reverse_proxy matomo:80\s*\}/m);
    expect(caddy).toMatch(/handle \{\s*reverse_proxy geo-ops:3000\s*\}/m);
    expect(caddy.indexOf("handle @matomo_tracking")).toBeLessThan(caddy.indexOf("handle {"));
    expect(caddy).not.toContain("/index.php");
    expect(caddy).not.toContain("API.get");
    expect(env).toContain("MATOMO_TRACKING_PUBLIC_BASE_URL");
    expect(env).toContain("MATOMO_TRACKING_JS_URL");
    expect(readme).toContain("MATOMO_TRACKING_PUBLIC_BASE_URL");
    expect(readme).toContain("/matomo.js");
  });

  it("keeps the development reporting network limited to SGeoOps and its worker", async () => {
    const compose = await source("docker-compose.yml");
    expect(service(compose, "geo-ops")).toContain("matomo-reporting");
    expect(service(compose, "geo-worker")).toContain("matomo-reporting");
    expect(service(compose, "trigger-dev")).not.toContain("matomo-reporting");
  });
});

describe("Matomo backup", () => {
  it("uses a restricted atomic dump without placing the password in process arguments", async () => {
    const script = await source("deploy/backup-matomo.sh");
    expect(script).toContain("set -Eeuo pipefail");
    expect(script).toContain("umask 077");
    expect(script).toContain("config --services");
    expect(script).toContain("ps --status running --services");
    expect(script).toContain("--defaults-extra-file");
    expect(script).not.toMatch(/(?:-p|--password(?:=|\s))\"?\$MARIADB_PASSWORD/);
    expect(script).toContain("gzip -9");
    expect(script).toContain("chmod 0600");
    expect(script).toContain("-mtime");
  });
});
