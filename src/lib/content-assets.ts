import { z } from "zod";
import type { ContentAsset, ContentAssetType, ContentLocale, CtaMode, PublishTarget, SchemaType } from "@/types/geo";
import { contentAssetTypes, contentLocales, ctaModes, publishTargets, schemaTypes } from "@/types/geo";
import { txpuroGuidesPath } from "@/lib/site-context";

const optionalTrimmedText = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.string().trim().optional(),
);

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "URL must use http or https.");

const optionalTrimmedUrl = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? undefined : value),
  httpUrl.optional(),
);

const keywordInput = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((input) => keywords(input))
  .refine((value) => value.length > 0, {
    message: "At least one target keyword is required.",
  });

const faqInput = z
  .array(
    z.object({
      question: z.string().trim().min(1),
      answer: z.string().trim().min(1),
    }),
  )
  .optional();

export const contentAssetInputSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  summary: optionalTrimmedText,
  brandEntity: z.string().trim().min(1),
  sourceUrl: optionalTrimmedUrl,
  targetKeywords: keywordInput,
  canonicalUrl: httpUrl,
  owner: optionalTrimmedText,
  slug: optionalTrimmedText,
  locale: z.enum(contentLocales).optional(),
  assetType: z.enum(contentAssetTypes).optional(),
  audience: optionalTrimmedText,
  seoTitle: optionalTrimmedText,
  metaDescription: optionalTrimmedText,
  faqs: faqInput,
  schemaType: z.enum(schemaTypes).optional(),
  ctaMode: z.enum(ctaModes).optional(),
  publishTarget: z.enum(publishTargets).optional(),
  isPublic: z.boolean().optional(),
  publishedPath: optionalTrimmedText,
});

export const scopedContentAssetInputSchema = contentAssetInputSchema.extend({
  siteId: z.string().trim().min(1),
});

export type ContentAssetInput = z.infer<typeof contentAssetInputSchema>;

function slug(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function keywords(input: string[] | string | undefined) {
  if (Array.isArray(input)) {
    return input.map((item) => item.trim()).filter(Boolean);
  }
  return (input ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSlug(input: string | undefined, title: string) {
  if (input?.trim()) {
    return input
      .trim()
      .split("/")
      .map((segment) => slug(segment))
      .filter(Boolean)
      .join("/") || "content";
  }
  return slug(title) || "content";
}

function normalizeLocale(input: ContentLocale | undefined) {
  return input || "zh-CN";
}

function normalizeAssetType(input: ContentAssetType | undefined) {
  return input || "guide-page";
}

const SCHEMA_TYPE_DEFAULTS: Record<ContentAssetType, SchemaType> = {
  "faq-page": "faq",
  "money-page": "product",
  "feature-page": "product",
  "guide-page": "article",
  "compare-page": "article",
};

function normalizeSchemaType(input: SchemaType | undefined, assetType: ContentAssetType): SchemaType {
  return input ?? SCHEMA_TYPE_DEFAULTS[assetType] ?? "article";
}

function normalizePublishTarget(input: PublishTarget | undefined, isPublic: boolean) {
  if (input) {
    return input;
  }
  return isPublic ? "txpuro" : "geo_ops_internal";
}

function normalizePublishedPath(
  input: string | undefined,
  locale: ContentLocale,
  pageSlug: string,
  publishTarget: PublishTarget,
) {
  if (input?.trim()) {
    return input.trim().startsWith("/") ? input.trim() : `/${input.trim()}`;
  }
  if (publishTarget === "txpuro") {
    return txpuroGuidesPath(pageSlug, locale);
  }
  return locale === "en" ? `/en/${pageSlug}` : `/${pageSlug}`;
}

export function buildContentAsset(input: ContentAssetInput, now = new Date()): ContentAsset {
  const timestamp = now.toISOString();
  const locale = normalizeLocale(input.locale);
  const assetType = normalizeAssetType(input.assetType);
  const pageSlug = normalizeSlug(input.slug, input.title);
  const isPublic = Boolean(input.isPublic);
  const publishTarget = normalizePublishTarget(input.publishTarget, isPublic);

  return {
    id: `asset_${pageSlug}_${locale.toLowerCase()}_${crypto.randomUUID().slice(0, 8)}`,
    title: input.title,
    body: input.body,
    summary: input.summary || input.body.replace(/\s+/g, " ").slice(0, 180),
    brandEntity: input.brandEntity,
    sourceUrl: input.sourceUrl || input.canonicalUrl,
    targetKeywords: input.targetKeywords,
    canonicalUrl: input.canonicalUrl,
    status: "Draft",
    geoScore: 0,
    updatedAt: timestamp,
    owner: input.owner || "GEO Ops",
    sourceSystem: "geo_ops",
    externalUrl: null,
    publishedAt: null,
    slug: pageSlug,
    locale,
    assetType,
    audience: input.audience || null,
    seoTitle: input.seoTitle || input.title,
    metaDescription: input.metaDescription || input.summary || input.body.replace(/\s+/g, " ").slice(0, 160),
    faqs: input.faqs || [],
    schemaType: normalizeSchemaType(input.schemaType, assetType),
    ctaMode: (input.ctaMode as CtaMode | undefined) || "self_signup",
    publishTarget,
    isPublic,
    publishedPath: normalizePublishedPath(input.publishedPath, locale, pageSlug, publishTarget),
  };
}
