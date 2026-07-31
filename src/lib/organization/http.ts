import { NextResponse } from "next/server";

import { AuthorizationError } from "@/lib/authorization";
import { ScopedOrganizationError } from "@/lib/organization/repository";

function hasPrismaCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function organizationRouteError(error: unknown) {
  if (error instanceof AuthorizationError) {
    if (error.code === "UNAUTHENTICATED") {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (
    error instanceof ScopedOrganizationError &&
    error.code === "RESOURCE_NOT_FOUND"
  ) {
    return NextResponse.json(
      { error: "Resource not found" },
      { status: 404 },
    );
  }

  if (hasPrismaCode(error, "P2002")) {
    return NextResponse.json(
      { error: "Resource already exists" },
      { status: 409 },
    );
  }

  if (hasPrismaCode(error, "P2003") || hasPrismaCode(error, "P2025")) {
    return NextResponse.json(
      { error: "Resource not found" },
      { status: 404 },
    );
  }

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 },
  );
}

export async function readJson(request: Request) {
  return request.json().catch(() => null);
}
