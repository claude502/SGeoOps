ALTER TABLE "ContentAsset"
ADD COLUMN "slug" TEXT,
ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'zh-CN',
ADD COLUMN "assetType" TEXT NOT NULL DEFAULT 'guide-page',
ADD COLUMN "audience" TEXT,
ADD COLUMN "seoTitle" TEXT,
ADD COLUMN "metaDescription" TEXT,
ADD COLUMN "faqs" JSONB,
ADD COLUMN "schemaType" TEXT NOT NULL DEFAULT 'article',
ADD COLUMN "ctaMode" TEXT NOT NULL DEFAULT 'self_signup',
ADD COLUMN "publishTarget" TEXT NOT NULL DEFAULT 'geo_ops_internal',
ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "publishedPath" TEXT;

CREATE INDEX "ContentAsset_publishTarget_isPublic_idx" ON "ContentAsset"("publishTarget", "isPublic");
CREATE INDEX "ContentAsset_locale_slug_idx" ON "ContentAsset"("locale", "slug");
