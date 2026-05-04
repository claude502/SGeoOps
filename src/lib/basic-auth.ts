export type BasicAuthConfig = {
  enabled: boolean;
  username: string | null;
  password: string | null;
  realm: string;
};

type EnvMap = Record<string, string | undefined>;

const DEFAULT_REALM = "GEO Ops";
const DISABLED_VALUES = new Set(["0", "false", "off", "no"]);

export function getBasicAuthConfig(env: EnvMap = process.env): BasicAuthConfig {
  const enabledValue = env.GEO_OPS_AUTH_ENABLED?.trim().toLowerCase();

  return {
    enabled: !enabledValue || !DISABLED_VALUES.has(enabledValue),
    username: env.GEO_OPS_ADMIN_USERNAME?.trim() || null,
    password: env.GEO_OPS_ADMIN_PASSWORD || null,
    realm: env.GEO_OPS_AUTH_REALM?.trim() || DEFAULT_REALM,
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
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  );
}

export function basicAuthChallenge(realm: string) {
  return `Basic realm="${realm.replaceAll('"', "")}", charset="UTF-8"`;
}
