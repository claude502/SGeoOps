import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  basicAuthChallenge,
  getBasicAuthConfig,
  isBasicAuthAuthorized,
  isBasicAuthConfigured,
  shouldBypassAuthPath,
} from "@/lib/basic-auth";

const failedAttempts = new Map<string, { count: number; resetAt: number }>();

const securityHeaders = {
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function withSecurityHeaders(response: NextResponse) {
  for (const [key, value] of Object.entries(securityHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

function clientKey(request: NextRequest) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function getAttemptState(key: string, windowSeconds: number) {
  const now = Date.now();
  const current = failedAttempts.get(key);

  if (!current || current.resetAt <= now) {
    const next = { count: 0, resetAt: now + windowSeconds * 1000 };
    failedAttempts.set(key, next);
    return next;
  }

  return current;
}

function registerFailedAttempt(key: string, windowSeconds: number) {
  const state = getAttemptState(key, windowSeconds);
  state.count += 1;
  failedAttempts.set(key, state);
  return state;
}

function isBlocked(key: string, maxAttempts: number, windowSeconds: number) {
  const state = getAttemptState(key, windowSeconds);
  return state.count >= maxAttempts ? state : null;
}

function clearFailedAttempts(key: string) {
  failedAttempts.delete(key);
}

function jsonResponse(body: unknown, status: number, headers?: HeadersInit) {
  return withSecurityHeaders(NextResponse.json(body, { status, headers }));
}

export function middleware(request: NextRequest) {
  if (shouldBypassAuthPath(request.nextUrl.pathname)) {
    return withSecurityHeaders(NextResponse.next());
  }

  const authConfig = getBasicAuthConfig();
  const key = clientKey(request);
  if (!authConfig.enabled) {
    return withSecurityHeaders(NextResponse.next());
  }

  if (!isBasicAuthConfigured(authConfig)) {
    return withSecurityHeaders(new NextResponse("GEO Ops authentication is not configured.", {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
      },
    }));
  }

  const blocked = isBlocked(key, authConfig.maxAttempts, authConfig.windowSeconds);
  if (blocked) {
    const retryAfter = Math.max(1, Math.ceil((blocked.resetAt - Date.now()) / 1000));
    return jsonResponse(
      { error: "Too many failed login attempts. Try again later." },
      429,
      {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfter),
      },
    );
  }

  if (isBasicAuthAuthorized(request.headers.get("authorization"), authConfig)) {
    clearFailedAttempts(key);
    if (
      authConfig.requireActionHeader &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers.get("x-geo-ops-action") !== "true"
    ) {
      return jsonResponse(
        { error: "Missing x-geo-ops-action header for write request." },
        403,
        { "Cache-Control": "no-store" },
      );
    }

    return withSecurityHeaders(NextResponse.next());
  }

  registerFailedAttempt(key, authConfig.windowSeconds);
  return withSecurityHeaders(new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": basicAuthChallenge(authConfig.realm),
    },
  }));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
