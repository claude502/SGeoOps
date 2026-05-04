import { z } from "zod";
import type { ContentAsset } from "@/types/geo";

const optionalTrimmedText = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.string().trim().optional(),
);

const optionalTrimmedUrl = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.string().trim().url().optional(),
);

const keywordInput = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((input) => keywords(input))
  .refine((value) => value.length > 0, {
    message: "At least one target keyword is required.",
  });

export const contentAssetInputSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  summary: optionalTrimmedText,
  brandEntity: z.string().trim().min(1),
  sourceUrl: optionalTrimmedUrl,
  targetKeywords: keywordInput,
  canonicalUrl: z.string().trim().url(),
  owner: optionalTrimmedText,
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

export function buildContentAsset(input: ContentAssetInput, now = new Date()): ContentAsset {
  const timestamp = now.toISOString();

  return {
    id: `asset_${slug(input.title) || "content"}_${now.getTime()}`,
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
  };
}
