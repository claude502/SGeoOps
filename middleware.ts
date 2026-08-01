import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isTxpuroHost, TXPURO_GUIDES_PREFIX } from "@/lib/site-context-hosts";

const securityHeaders = {
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function requestId(request: NextRequest) {
  return (
    request.headers.get("x-request-id") ||
    request.headers.get("cf-ray") ||
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function withSecurityHeaders(response: NextResponse, id: string) {
  for (const [key, value] of Object.entries(securityHeaders)) {
    response.headers.set(key, value);
  }
  response.headers.set("X-Request-ID", id);
  return response;
}

function nextResponse(request: NextRequest, id: string) {
  const headers = new Headers(request.headers);
  headers.set("x-request-id", id);
  return withSecurityHeaders(NextResponse.next({ request: { headers } }), id);
}

function isPublicGuidePath(pathname: string) {
  return (
    pathname === "/llms.txt" ||
    pathname === "/sitemap-guides.xml" ||
    pathname === TXPURO_GUIDES_PREFIX ||
    pathname.startsWith(`${TXPURO_GUIDES_PREFIX}/`)
  );
}

export function middleware(request: NextRequest) {
  const id = requestId(request);
  const pathname = request.nextUrl.pathname;

  // Public ownership is enforced by the public route's site resolver. Middleware
  // remains datastore-free so it can safely run before either public or ops code.
  if (
    isTxpuroHost(request.headers.get("host")) &&
    isPublicGuidePath(pathname)
  ) {
    return nextResponse(request, id);
  }

  return nextResponse(request, id);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
