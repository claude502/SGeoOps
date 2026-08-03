import { NextResponse } from "next/server";

import { prepareSignedInternalRequest } from "@/lib/internal-auth";
import {
  createDefaultSearchConsoleDispatcher,
  type SearchConsoleDispatcher,
} from "@/lib/search-console/dispatcher";
import {
  createSearchConsoleDispatchCursor,
  parseSearchConsoleDispatchCursor,
} from "@/lib/search-console/dispatch-cursor";
import { readBoundedJsonBody } from "@/lib/search-console/internal-route";

type DispatchControl = Pick<SearchConsoleDispatcher, "dispatchPage">;
const maximumDispatchResponseBytes = 64 * 1024;

function jsonError(status: number, error: string, code: string) {
  return NextResponse.json({ error, code }, { status });
}

type DispatchRequest = {
  scheduledAt: Date;
  cursor: string | null;
};

function parseDispatchRequest(value: unknown): DispatchRequest | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join("\u0000");
  if (keys !== "scheduledAt" && keys !== "cursor\u0000scheduledAt") return null;
  const scheduledAt = record.scheduledAt;
  if (typeof scheduledAt !== "string") return null;
  const parsed = new Date(scheduledAt);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== scheduledAt) return null;
  if (keys === "scheduledAt") return { scheduledAt: parsed, cursor: null };
  return typeof record.cursor === "string" && record.cursor.length > 0 && record.cursor.length <= 2_048
    ? { scheduledAt: parsed, cursor: record.cursor }
    : null;
}

export function createSearchConsoleDispatchRoute(
  createDispatcher: () => DispatchControl = createDefaultSearchConsoleDispatcher,
) {
  return async function POST(request: Request) {
    const prepared = await prepareSignedInternalRequest(request);
    if (prepared === null) {
      await request.body?.cancel().catch(() => undefined);
      return jsonError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = await readBoundedJsonBody(request);
    if (!body.ok) {
      if (body.digest !== undefined && !await prepared.verifyBodyDigest(body.digest)) {
        return jsonError(401, "Unauthorized", "UNAUTHORIZED");
      }
      return jsonError(
        body.code === "TOO_LARGE" ? 413 : 400,
        "Invalid Search Console dispatch request",
        body.code === "TOO_LARGE" ? "DISPATCH_BODY_TOO_LARGE" : "INVALID_DISPATCH_BODY",
      );
    }
    if (!await prepared.verifyBodyDigest(body.digest)) {
      return jsonError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const dispatchRequest = parseDispatchRequest(body.body);
    if (dispatchRequest === null) {
      return jsonError(400, "Invalid Search Console dispatch request", "INVALID_DISPATCH_BODY");
    }
    try {
      const scheduledAt = dispatchRequest.scheduledAt.toISOString();
      const afterIntegrationId = dispatchRequest.cursor === null
        ? null
        : await parseSearchConsoleDispatchCursor(dispatchRequest.cursor, scheduledAt);
      if (dispatchRequest.cursor !== null && afterIntegrationId === null) {
        return jsonError(400, "Invalid Search Console dispatch request", "INVALID_DISPATCH_CURSOR");
      }
      const page = await createDispatcher().dispatchPage(
        dispatchRequest.scheduledAt,
        afterIntegrationId,
      );
      const cursor = page.nextAfterIntegrationId === null
        ? null
        : await createSearchConsoleDispatchCursor(scheduledAt, page.nextAfterIntegrationId);
      const payload = { runs: page.runs, cursor };
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > maximumDispatchResponseBytes) {
        return jsonError(500, "Search Console dispatch page is too large", "DISPATCH_PAGE_TOO_LARGE");
      }
      return NextResponse.json(
        payload,
        { headers: { "cache-control": "no-store" } },
      );
    } catch {
      return jsonError(
        500,
        "Search Console dispatch failed",
        "SEARCH_CONSOLE_DISPATCH_FAILED",
      );
    }
  };
}

export const POST = createSearchConsoleDispatchRoute();
