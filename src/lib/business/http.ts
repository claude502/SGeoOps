import { NextResponse } from "next/server";

import { AuthorizationError } from "@/lib/authorization";

export type ScopedBusinessErrorCode =
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_CONFLICT";

export class ScopedBusinessError extends Error {
  constructor(readonly code: ScopedBusinessErrorCode) {
    super(code);
    this.name = "ScopedBusinessError";
  }
}

function hasPrismaCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function businessRouteError(error: unknown) {
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
    error instanceof ScopedBusinessError &&
    error.code === "RESOURCE_NOT_FOUND"
  ) {
    return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  }

  if (
    (error instanceof ScopedBusinessError &&
      error.code === "RESOURCE_CONFLICT") ||
    hasPrismaCode(error, "P2002")
  ) {
    return NextResponse.json({ error: "Resource conflict" }, { status: 409 });
  }

  if (hasPrismaCode(error, "P2003") || hasPrismaCode(error, "P2025")) {
    return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  }

  console.error("[business-api] Internal failure", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 },
  );
}
