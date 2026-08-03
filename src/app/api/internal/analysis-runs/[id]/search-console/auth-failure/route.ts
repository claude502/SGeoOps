import { NextResponse } from "next/server";

import {
  createDefaultSearchConsoleControlPlane,
  SearchConsoleControlError,
  type SearchConsoleControlPlane,
} from "@/lib/search-console/control-plane";
import {
  parseSearchConsoleControlRequestScope,
  parseSearchConsoleRunId,
  readBoundedJsonBody,
} from "@/lib/search-console/internal-route";
import { prepareSignedInternalRequest } from "@/lib/internal-auth";

type AuthFailureControl = Pick<SearchConsoleControlPlane, "disableAfterAuthenticationFailure">;
type RouteContext = { params: Promise<{ id: string }> };

function jsonError(status: number, error: string, code: string) {
  return NextResponse.json({ error, code }, { status });
}

export function createSearchConsoleAuthFailureRoute(
  createControl: () => AuthFailureControl = createDefaultSearchConsoleControlPlane,
) {
  return async function POST(request: Request, context: RouteContext) {
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
        "Invalid Search Console control request",
        body.code === "TOO_LARGE" ? "CONTROL_BODY_TOO_LARGE" : "INVALID_CONTROL_BODY",
      );
    }
    if (!await prepared.verifyBodyDigest(body.digest)) {
      return jsonError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { id } = await context.params;
    const runId = parseSearchConsoleRunId(id);
    const scope = parseSearchConsoleControlRequestScope(body.body);
    if (runId === null || scope === null) {
      return jsonError(400, "Invalid Search Console control request", "INVALID_CONTROL_BODY");
    }
    try {
      const result = await createControl().disableAfterAuthenticationFailure({ runId, ...scope });
      return NextResponse.json(result, { status: 202 });
    } catch (error) {
      if (error instanceof SearchConsoleControlError) {
        return jsonError(404, "Search Console control scope not found", "CONTROL_SCOPE_NOT_FOUND");
      }
      return jsonError(500, "Search Console control request failed", "CONTROL_REQUEST_FAILED");
    }
  };
}

export const POST = createSearchConsoleAuthFailureRoute();
