import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSearchConsoleDispatchCursor,
  parseSearchConsoleDispatchCursor,
} from "./dispatch-cursor";

const secret = "search-console-dispatch-cursor-secret";
const originalSecret = process.env.SGEO_INTERNAL_SECRET;
const scheduledAt = "2026-08-04T07:30:00.000Z";

beforeEach(() => {
  process.env.SGEO_INTERNAL_SECRET = secret;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.SGEO_INTERNAL_SECRET;
  else process.env.SGEO_INTERNAL_SECRET = originalSecret;
});

describe("Search Console dispatch cursor", () => {
  it("returns an opaque authenticated cursor bound to one schedule instant", async () => {
    const cursor = await createSearchConsoleDispatchCursor(
      scheduledAt,
      "integration_001",
    );

    expect(cursor).not.toContain("integration_001");
    await expect(parseSearchConsoleDispatchCursor(cursor, scheduledAt))
      .resolves.toBe("integration_001");
    await expect(parseSearchConsoleDispatchCursor(cursor, "2026-08-05T07:30:00.000Z"))
      .resolves.toBeNull();
  });

  it("rejects a tampered or malformed cursor", async () => {
    const cursor = await createSearchConsoleDispatchCursor(
      scheduledAt,
      "integration_001",
    );
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;

    await expect(parseSearchConsoleDispatchCursor(tampered, scheduledAt))
      .resolves.toBeNull();
    await expect(parseSearchConsoleDispatchCursor("integration_001", scheduledAt))
      .resolves.toBeNull();
  });
});
