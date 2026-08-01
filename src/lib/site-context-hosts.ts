import { normalizeHost as normalizeOrganizationHost } from "@/lib/organization/schemas";

const defaultTxpuroCanonicalHosts = ["txpuro.com", "www.txpuro.com"];
const defaultTxpuroOriginHosts = ["geo-origin.winghengtech.com"];
const defaultOpsHosts = ["wingheng.technology", "www.wingheng.technology"];
export const TXPURO_GUIDES_PREFIX = "/guides";

export function normalizeSiteHost(value: string | null | undefined) {
  try {
    return normalizeOrganizationHost(value ?? "");
  } catch {
    return "";
  }
}

function envHosts(value: string | undefined, fallback: string[]) {
  const hosts = (value ?? "")
    .split(",")
    .map((item) => normalizeSiteHost(item))
    .filter(Boolean);
  return hosts.length ? hosts : fallback;
}

export function getTxpuroCanonicalHosts() {
  return envHosts(
    [process.env.TXPURO_PUBLIC_HOST, process.env.TXPURO_PUBLIC_HOST_WWW]
      .filter(Boolean)
      .join(","),
    defaultTxpuroCanonicalHosts,
  );
}

export function getTxpuroOriginHosts() {
  return envHosts(process.env.TXPURO_ORIGIN_HOST, defaultTxpuroOriginHosts);
}

export function getTxpuroServeHosts() {
  return Array.from(
    new Set([...getTxpuroCanonicalHosts(), ...getTxpuroOriginHosts()]),
  );
}

export function getOpsHosts() {
  return envHosts(
    [process.env.NEXT_PUBLIC_APP_URL]
      .filter(Boolean)
      .map((value) => {
        try {
          return new URL(value!).host;
        } catch {
          return value!;
        }
      })
      .join(","),
    defaultOpsHosts,
  );
}

export function isTxpuroHost(host: string | null | undefined) {
  const normalized = normalizeSiteHost(host);
  return Boolean(normalized && getTxpuroServeHosts().includes(normalized));
}

export function isOpsHost(host: string | null | undefined) {
  const normalized = normalizeSiteHost(host);
  return getOpsHosts().includes(normalized);
}

export function preferredTxpuroHost() {
  return getTxpuroCanonicalHosts()[0] || "txpuro.com";
}

export function txpuroBaseUrl() {
  return `https://${preferredTxpuroHost()}`;
}
