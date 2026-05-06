-- AlterTable
ALTER TABLE "ContentAsset" ADD COLUMN     "seoScore" INTEGER,
ADD COLUMN     "templateId" TEXT,
ADD COLUMN     "trendTopicId" TEXT;

-- CreateTable
CREATE TABLE "TrendTopic" (
    "id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'CN',
    "sourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrendTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantMetric" (
    "id" TEXT NOT NULL,
    "channelVariantId" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "recordedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoAudit" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "issues" JSONB NOT NULL,
    "cwv" JSONB,
    "auditedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordRanking" (
    "id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordRanking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrendTopic_status_idx" ON "TrendTopic"("status");

-- CreateIndex
CREATE INDEX "TrendTopic_platform_idx" ON "TrendTopic"("platform");

-- CreateIndex
CREATE INDEX "TrendTopic_capturedAt_idx" ON "TrendTopic"("capturedAt");

-- CreateIndex
CREATE INDEX "VariantMetric_channelVariantId_idx" ON "VariantMetric"("channelVariantId");

-- CreateIndex
CREATE INDEX "VariantMetric_recordedAt_idx" ON "VariantMetric"("recordedAt");

-- CreateIndex
CREATE INDEX "SeoAudit_url_idx" ON "SeoAudit"("url");

-- CreateIndex
CREATE INDEX "SeoAudit_auditedAt_idx" ON "SeoAudit"("auditedAt");

-- CreateIndex
CREATE INDEX "KeywordRanking_keyword_idx" ON "KeywordRanking"("keyword");

-- CreateIndex
CREATE INDEX "KeywordRanking_url_idx" ON "KeywordRanking"("url");

-- CreateIndex
CREATE INDEX "KeywordRanking_recordedAt_idx" ON "KeywordRanking"("recordedAt");

-- AddForeignKey
ALTER TABLE "ContentAsset" ADD CONSTRAINT "ContentAsset_trendTopicId_fkey" FOREIGN KEY ("trendTopicId") REFERENCES "TrendTopic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantMetric" ADD CONSTRAINT "VariantMetric_channelVariantId_fkey" FOREIGN KEY ("channelVariantId") REFERENCES "ChannelVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
