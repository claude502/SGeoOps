import { NextResponse } from "next/server";

import { prepareSignedInternalRequest } from "@/lib/internal-auth";
import {
  createDefaultMatomoControlPlane,
  MatomoControlError,
  type MatomoControlPlane,
} from "@/lib/matomo/control-plane";
import {
  parseMatomoControlRequestScope,
  parseMatomoRunId,
  readBoundedJsonBody,
} from "@/lib/matomo/internal-route";

type CredentialControl = Pick<MatomoControlPlane, "getCredential">;
type RouteContext = { params: Promise<{ id: string }> };

function jsonError(status: number, code: string) {
  return NextResponse.json({ error: "Matomo control request failed", code }, { status });
}

export function createMatomoCredentialRoute(
  createControl: () => CredentialControl = createDefaultMatomoControlPlane,
) {
  return async function POST(request: Request, context: RouteContext) {
    const prepared = await prepareSignedInternalRequest(request);
    if (prepared === null) {
      await request.body?.cancel().catch(() => undefined);
      return jsonError(401, "UNAUTHORIZED");
    }
    const body = await readBoundedJsonBody(request);
    if (!body.ok) {
      if (body.digest !== undefined && !await prepared.verifyBodyDigest(body.digest)) {
        return jsonError(401, "UNAUTHORIZED");
      }
      return jsonError(
        body.code === "TOO_LARGE" ? 413 : 400,
        body.code === "TOO_LARGE" ? "CONTROL_BODY_TOO_LARGE" : "INVALID_CONTROL_BODY",
      );
    }
    if (!await prepared.verifyBodyDigest(body.digest)) {
      return jsonError(401, "UNAUTHORIZED");
    }
    const runId = parseMatomoRunId((await context.params).id);
    const scope = parseMatomoControlRequestScope(body.body);
    if (runId === null || scope === null) {
      return jsonError(400, "INVALID_CONTROL_BODY");
    }
    try {
      return NextResponse.json(
        await createControl().getCredential({ runId, ...scope }),
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      return jsonError(
        error instanceof MatomoControlError ? 404 : 500,
        error instanceof MatomoControlError
          ? "CONTROL_SCOPE_NOT_FOUND"
          : "CONTROL_REQUEST_FAILED",
      );
    }
  };
}

export const POST = createMatomoCredentialRoute();
