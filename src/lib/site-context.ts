import type { ContentLocale } from "@/types/geo";

const defaultTxpuroCanonicalHosts = ["txpuro.com", "www.txpuro.com"];
const defaultTxpuroOriginHosts = ["geo-origin.winghengtech.com"];
const defaultOpsHosts = ["wingheng.technology", "www.wingheng.technology"];
export const TXPURO_GUIDES_PREFIX = "/guides";

function normalizeHost(value: string | null | undefined) {
  return (value || "").split(":")[0].trim().toLowerCase();
}

function envHosts(value: string | undefined, fallback: string[]) {
  const hosts = (value ?? "")
    .split(",")
    .map((item) => normalizeHost(item))
    .filter(Boolean);
  return hosts.length ? hosts : fallback;
}

export function getTxpuroCanonicalHosts() {
  return envHosts(
    [process.env.TXPURO_PUBLIC_HOST, process.env.TXPURO_PUBLIC_HOST_WWW].filter(Boolean).join(","),
    defaultTxpuroCanonicalHosts,
  );
}

export function getTxpuroOriginHosts() {
  return envHosts(process.env.TXPURO_ORIGIN_HOST, defaultTxpuroOriginHosts);
}

export function getTxpuroServeHosts() {
  return Array.from(new Set([...getTxpuroCanonicalHosts(), ...getTxpuroOriginHosts()]));
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
  const normalized = normalizeHost(host);
  return getTxpuroServeHosts().includes(normalized);
}

export function isOpsHost(host: string | null | undefined) {
  const normalized = normalizeHost(host);
  return getOpsHosts().includes(normalized);
}

export function preferredTxpuroHost() {
  return getTxpuroCanonicalHosts()[0] || "txpuro.com";
}

export function txpuroBaseUrl() {
  return `https://${preferredTxpuroHost()}`;
}

function normalizeGuidesSlug(slug: string) {
  const trimmed = slug.trim().replace(/^\/+|\/+$/g, "");
  return trimmed.replace(/^guides\//, "");
}

export function txpuroGuidesPath(slug: string, locale: ContentLocale) {
  const normalized = normalizeGuidesSlug(slug);
  if (locale === "en") {
    return normalized && normalized !== "home"
      ? `${TXPURO_GUIDES_PREFIX}/en/${normalized}`
      : `${TXPURO_GUIDES_PREFIX}/en`;
  }
  return normalized && normalized !== "home"
    ? `${TXPURO_GUIDES_PREFIX}/${normalized}`
    : TXPURO_GUIDES_PREFIX;
}

export function txpuroCanonicalUrl(slug: string, locale: ContentLocale) {
  return `${txpuroBaseUrl()}${txpuroGuidesPath(slug, locale)}`;
}

export function normalizeLocaleFromGuidesSlug(slug: string[] | undefined) {
  if (slug?.[0] === "en") {
    return { locale: "en" as const, pathSegments: slug.slice(1) };
  }
  return { locale: "zh-CN" as const, pathSegments: slug ?? [] };
}
