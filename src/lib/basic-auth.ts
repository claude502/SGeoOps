export type BasicAuthConfig = {
  enabled: boolean;
  username: string | null;
  password: string | null;
  realm: string;
  maxAttempts: number;
  windowSeconds: number;
  requireActionHeader: boolean;
};

type EnvMap = Record<string, string | undefined>;

const DEFAULT_REALM = "GEO Ops";
const DISABLED_VALUES = new Set(["0", "false", "off", "no"]);
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_WINDOW_SECONDS = 300;

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnabled(value: string | undefined, defaultValue: boolean) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  return !DISABLED_VALUES.has(normalized);
}

export function getBasicAuthConfig(env: EnvMap = process.env): BasicAuthConfig {
  return {
    enabled: parseEnabled(env.GEO_OPS_AUTH_ENABLED, true),
    username: env.GEO_OPS_ADMIN_USERNAME?.trim() || null,
    password: env.GEO_OPS_ADMIN_PASSWORD || null,
    realm: env.GEO_OPS_AUTH_REALM?.trim() || DEFAULT_REALM,
    maxAttempts: parsePositiveInt(env.GEO_OPS_AUTH_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
    windowSeconds: parsePositiveInt(env.GEO_OPS_AUTH_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS),
    requireActionHeader: parseEnabled(env.GEO_OPS_REQUIRE_ACTION_HEADER, true),
  };
}

export function parseBasicAuthorization(header: string | null) {
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(" ", 2);
  if (scheme?.toLowerCase() !== "basic" || !token) {
    return null;
  }

  try {
    const decoded = globalThis.atob(token);
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      return null;
    }

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export function timingSafeStringEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}

export function isBasicAuthConfigured(config: BasicAuthConfig) {
  return Boolean(config.username && config.password);
}

export function isBasicAuthAuthorized(header: string | null, config: BasicAuthConfig) {
  if (!config.enabled) {
    return true;
  }

  if (!isBasicAuthConfigured(config)) {
    return false;
  }

  const credentials = parseBasicAuthorization(header);
  if (!credentials) {
    return false;
  }

  return (
    timingSafeStringEqual(credentials.username, config.username ?? "") &&
    timingSafeStringEqual(credentials.password, config.password ?? "")
  );
}

export function shouldBypassAuthPath(pathname: string) {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/_next/image/") ||
    pathname === "/api/healthz" ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  );
}

export function basicAuthChallenge(realm: string) {
  return `Basic realm="${realm.replaceAll('"', "")}", charset="UTF-8"`;
}
