import type { ResolvedPublicSite } from "@/lib/organization/repository";
import { organizationRepository } from "@/lib/organization/repository";
import { isDatabaseConfigured } from "@/lib/prisma";
import type { ContentLocale } from "@/types/geo";
import {
  getTxpuroOriginHosts,
  getTxpuroServeHosts,
  isOpsHost,
  isTxpuroHost,
  normalizeSiteHost,
  preferredTxpuroHost,
  TXPURO_GUIDES_PREFIX,
} from "@/lib/site-context-hosts";

export {
  getOpsHosts,
  getTxpuroCanonicalHosts,
  getTxpuroOriginHosts,
  getTxpuroServeHosts,
  isOpsHost,
  isTxpuroHost,
  preferredTxpuroHost,
  txpuroBaseUrl,
  TXPURO_GUIDES_PREFIX,
} from "@/lib/site-context-hosts";

export type { ResolvedPublicSite } from "@/lib/organization/repository";

export type ResolvedPublicRoute = Pick<
  ResolvedPublicSite,
  "siteId"
> & {
  locale: ContentLocale;
  slug: string;
};

function staticTxpuroSite(): ResolvedPublicSite {
  const canonicalHost = preferredTxpuroHost();
  return {
    workspaceId: "workspace_internal",
    clientId: "client_wing_heng",
    brandId: "brand_txpuro",
    siteId: "site_txpuro_com",
    name: "Txpuro",
    canonicalHost,
    originHosts: getTxpuroOriginHosts(),
    siteType: "content",
    hostingMode: "hybrid",
    canonicalRules: { https: true, www: "redirect" },
    allowedPublishPaths: [TXPURO_GUIDES_PREFIX],
  };
}

function staticTxpuroSiteForHost(host: string) {
  return getTxpuroServeHosts().includes(host) ? staticTxpuroSite() : null;
}

/**
 * Resolves a public hostname from the database-backed Site ownership model.
 * Txpuro retains a static fallback only while a database is unavailable so its
 * established public URLs continue to work during bootstrap and recovery.
 */
export async function resolvePublicSite(
  host: string | null | undefined,
): Promise<ResolvedPublicSite | null> {
  const normalizedHost = normalizeSiteHost(host);
  if (!normalizedHost) {
    return null;
  }

  if (isDatabaseConfigured()) {
    try {
      const site = await organizationRepository.resolveSiteByHost(
        normalizedHost,
      );
      if (site) {
        return site;
      }
    } catch {
      return staticTxpuroSiteForHost(normalizedHost);
    }
  }

  return staticTxpuroSiteForHost(normalizedHost);
}

function contentPathPrefix(site: ResolvedPublicSite) {
  return (
    site.allowedPublishPaths.find(
      (path) => path.startsWith("/") && !path.startsWith("//"),
    ) ?? TXPURO_GUIDES_PREFIX
  ).replace(/\/+$/, "") || TXPURO_GUIDES_PREFIX;
}

function normalizeContentSlug(slug: string, prefix: string) {
  const normalized = slug.trim().replace(/^\/+|\/+$/g, "");
  const prefixSlug = prefix.replace(/^\/+|\/+$/g, "");
  if (normalized === prefixSlug) {
    return "";
  }
  return normalized.startsWith(`${prefixSlug}/`)
    ? normalized.slice(prefixSlug.length + 1)
    : normalized;
}

export function publicContentPath(
  site: ResolvedPublicSite,
  slug: string,
  locale: string,
) {
  const prefix = contentPathPrefix(site);
  const normalizedSlug = normalizeContentSlug(slug, prefix);
  const localePrefix = locale.toLowerCase() === "en" ? "/en" : "";
  const basePath = `${prefix}${localePrefix}`;

  return normalizedSlug && normalizedSlug !== "home"
    ? `${basePath}/${normalizedSlug}`
    : basePath;
}

export function publicCanonicalUrl(
  site: ResolvedPublicSite,
  slug: string,
  locale: string,
) {
  return `https://${site.canonicalHost}${publicContentPath(site, slug, locale)}`;
}

export async function resolvePublicRoute(
  host: string | null | undefined,
  pathname: string,
): Promise<ResolvedPublicRoute | null> {
  if (!pathname.startsWith("/")) {
    return null;
  }

  const site = await resolvePublicSite(host);
  if (!site) {
    return null;
  }

  let parsedPathname: string;
  try {
    parsedPathname = new URL(pathname, "https://public-route.invalid").pathname;
  } catch {
    return null;
  }

  const prefix = contentPathPrefix(site).split("/").filter(Boolean);
  const segments = parsedPathname.split("/").filter(Boolean);
  if (
    prefix.length > segments.length ||
    prefix.some((segment, index) => segments[index] !== segment)
  ) {
    return null;
  }

  const contentSegments = segments.slice(prefix.length);
  const locale = contentSegments[0] === "en" ? "en" : "zh-CN";
  const slugSegments = locale === "en" ? contentSegments.slice(1) : contentSegments;

  return {
    siteId: site.siteId,
    locale,
    slug: slugSegments.join("/") || "home",
  };
}

export function txpuroGuidesPath(slug: string, locale: ContentLocale) {
  return publicContentPath(staticTxpuroSite(), slug, locale);
}

export function txpuroCanonicalUrl(slug: string, locale: ContentLocale) {
  return publicCanonicalUrl(staticTxpuroSite(), slug, locale);
}

export function normalizeLocaleFromGuidesSlug(slug: string[] | undefined) {
  if (slug?.[0] === "en") {
    return { locale: "en" as const, pathSegments: slug.slice(1) };
  }
  return { locale: "zh-CN" as const, pathSegments: slug ?? [] };
}
