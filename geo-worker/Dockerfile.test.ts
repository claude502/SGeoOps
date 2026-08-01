import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");

describe("geo-worker development image", () => {
  it("provides the system Chromium binary to the non-root Unlighthouse worker without a Docker socket", () => {
    expect(dockerfile).toMatch(/apk add --no-cache ca-certificates chromium/);
    expect(dockerfile).toContain("ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium");
    expect(dockerfile).toContain("test -x /usr/bin/chromium");
    expect(dockerfile).toContain("/usr/bin/chromium --version");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).not.toMatch(/docker\.sock|docker socket|docker-cli/i);
  });
});
