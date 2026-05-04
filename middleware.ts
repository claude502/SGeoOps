import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  basicAuthChallenge,
  getBasicAuthConfig,
  isBasicAuthAuthorized,
  isBasicAuthConfigured,
  shouldBypassAuthPath,
} from "@/lib/basic-auth";

export function middleware(request: NextRequest) {
  if (shouldBypassAuthPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const authConfig = getBasicAuthConfig();
  if (!authConfig.enabled) {
    return NextResponse.next();
  }

  if (!isBasicAuthConfigured(authConfig)) {
    return new NextResponse("GEO Ops authentication is not configured.", {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  if (isBasicAuthAuthorized(request.headers.get("authorization"), authConfig)) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": basicAuthChallenge(authConfig.realm),
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
