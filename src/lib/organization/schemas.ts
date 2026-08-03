import { z } from "zod";

import { parseSearchConsoleProperty } from "@/lib/search-console/property";

const shortText = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Invalid text");
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const jsonObject = z.record(z.string(), z.json());
const nullableJsonObject = jsonObject.nullable().default(null);

function deduplicate(values: string[]) {
  return [...new Set(values)];
}

export function normalizeHost(host: string): string {
  const value = host.trim();
  if (
    value.length === 0 ||
    value.length > 253 ||
    value.includes("://") ||
    /[\s/@\\?#\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("HOST_INVALID");
  }

  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new Error("HOST_INVALID");
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("HOST_INVALID");
  }

  const normalized = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    normalized.includes(":") ||
    normalized.split(".").some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new Error("HOST_INVALID");
  }

  return normalized;
}

const host = z.string().transform((value, context) => {
  try {
    return normalizeHost(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Invalid host",
    });
    return z.NEVER;
  }
});

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const normalizedStrings = z
  .array(shortText)
  .max(100)
  .transform((values) => deduplicate(values.map((value) => value.trim())));

const publishPath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => {
    if (
      !value.startsWith("/") ||
      value.startsWith("//") ||
      value.includes("\\") ||
      value.includes("?") ||
      value.includes("#") ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      return false;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return false;
    }
    return (
      decoded.startsWith("/") &&
      !decoded.startsWith("//") &&
      !decoded.includes("\\") &&
      !decoded
        .split("/")
        .some((segment) => segment === "." || segment === "..")
    );
  }, "Invalid publish path");

const integrationEndpoint = z.string().max(2_048).nullable().default(null);

function isHttpEndpoint(value: string) {
  if (!z.url().safeParse(value).success) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

const locale = z
  .string()
  .trim()
  .regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2})?$/)
  .transform((value) => {
    const [language, country] = value.split("-");
    return country
      ? `${language.toLowerCase()}-${country.toUpperCase()}`
      : language.toLowerCase();
  });

function isSafeSecretReference(reference: string) {
  const relativePath = reference.slice("file:".length);
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith("/") &&
    !relativePath.includes("\\") &&
    !relativePath.includes("\u0000") &&
    relativePath
      .split("/")
      .every(
        (segment) =>
          segment.length > 0 && segment !== "." && segment !== "..",
      )
  );
}

export const pathIdSchema = identifier;

export const createClientSchema = z
  .object({
    name: shortText,
    slug,
    active: z.boolean().default(true),
  })
  .strict();

export const createBrandSchema = z
  .object({
    name: shortText,
    slug,
    aliases: normalizedStrings.default([]),
    products: nullableJsonObject,
    industry: shortText.nullable().default(null),
    goals: nullableJsonObject,
    riskCategory: shortText.default("standard"),
  })
  .strict();

export const createSiteSchema = z
  .object({
    name: shortText,
    canonicalHost: host,
    originHosts: z
      .array(host)
      .max(100)
      .default([])
      .transform(deduplicate),
    siteType: shortText,
    hostingMode: shortText,
    canonicalRules: jsonObject,
    allowedPublishPaths: z
      .array(publishPath)
      .max(100)
      .default([])
      .transform(deduplicate),
    active: z.boolean().default(true),
  })
  .strict()
  .transform((value) => ({
    ...value,
    originHosts: value.originHosts.filter(
      (originHost) => originHost !== value.canonicalHost,
    ),
  }));

export const createSiteMarketSchema = z
  .object({
    country: z
      .string()
      .trim()
      .regex(/^[a-zA-Z]{2}$/)
      .transform((value) => value.toUpperCase()),
    locale,
    defaultDevice: z.enum(["desktop", "mobile", "tablet"]).default("desktop"),
    timezone: shortText,
    settings: nullableJsonObject,
  })
  .strict();

export const createIntegrationSchema = z
  .object({
    siteMarketId: identifier.nullable().default(null),
    type: shortText,
    endpoint: integrationEndpoint,
    capabilities: normalizedStrings.default([]),
    adapterVersion: shortText,
    secretRef: z
      .string()
      .trim()
      .min(6)
      .max(500)
      .startsWith("file:")
      .refine(isSafeSecretReference, "Invalid secret reference")
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endpoint === null) return;
    const valid = value.type === "search_console"
      ? parseSearchConsoleProperty(value.endpoint) !== null
      : isHttpEndpoint(value.endpoint);
    if (!valid) {
      context.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: value.type === "search_console"
          ? "Invalid Search Console property"
          : "Endpoint must use HTTP or HTTPS",
      });
    }
  });

export type CreateClientBody = z.infer<typeof createClientSchema>;
export type CreateBrandBody = z.infer<typeof createBrandSchema>;
export type CreateSiteBody = z.infer<typeof createSiteSchema>;
export type CreateSiteMarketBody = z.infer<typeof createSiteMarketSchema>;
export type CreateIntegrationBody = z.infer<typeof createIntegrationSchema>;
