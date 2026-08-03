import { NextResponse } from "next/server";

import { prepareSignedInternalRequest } from "@/lib/internal-auth";
import {
  createDefaultSearchConsoleDispatcher,
  type SearchConsoleDispatcher,
} from "@/lib/search-console/dispatcher";
import { readBoundedJsonBody } from "@/lib/search-console/internal-route";

type DispatchControl = Pick<SearchConsoleDispatcher, "dispatch">;

function jsonError(status: number, error: string, code: string) {
  return NextResponse.json({ error, code }, { status });
}

function parseScheduledAt(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).join("\u0000") !== "scheduledAt"
  ) {
    return null;
  }
  const scheduledAt = (value as Record<string, unknown>).scheduledAt;
  if (typeof scheduledAt !== "string") return null;
  const parsed = new Date(scheduledAt);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === scheduledAt
    ? parsed
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
    const scheduledAt = parseScheduledAt(body.body);
    if (scheduledAt === null) {
      return jsonError(400, "Invalid Search Console dispatch request", "INVALID_DISPATCH_BODY");
    }
    try {
      const runs = await createDispatcher().dispatch(scheduledAt);
      return NextResponse.json(
        { runs },
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
