-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('Draft', 'Review', 'Ready', 'Scheduled');

-- CreateEnum
CREATE TYPE "GeoFlowTaskStatus" AS ENUM ('not_sent', 'queued', 'generating', 'reviewing', 'published', 'failed');

-- CreateTable
CREATE TABLE "ContentAsset" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "brandEntity" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "targetKeywords" TEXT[],
    "canonicalUrl" TEXT NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'Draft',
    "geoScore" INTEGER NOT NULL DEFAULT 0,
    "owner" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL DEFAULT 'geo_ops',
    "externalUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoFlowTaskLink" (
    "id" TEXT NOT NULL,
    "contentAssetId" TEXT NOT NULL,
    "geoFlowTaskId" INTEGER,
    "geoFlowJobId" INTEGER,
    "geoFlowArticleId" INTEGER,
    "geoFlowArticleUrl" TEXT,
    "status" "GeoFlowTaskStatus" NOT NULL DEFAULT 'not_sent',
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "taskPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoFlowTaskLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoFlowSyncRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,

    CONSTRAINT "GeoFlowSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentAsset_status_idx" ON "ContentAsset"("status");

-- CreateIndex
CREATE INDEX "ContentAsset_sourceSystem_idx" ON "ContentAsset"("sourceSystem");

-- CreateIndex
CREATE INDEX "ContentAsset_publishedAt_idx" ON "ContentAsset"("publishedAt");

-- CreateIndex
CREATE INDEX "GeoFlowTaskLink_contentAssetId_idx" ON "GeoFlowTaskLink"("contentAssetId");

-- CreateIndex
CREATE INDEX "GeoFlowTaskLink_geoFlowTaskId_idx" ON "GeoFlowTaskLink"("geoFlowTaskId");

-- CreateIndex
CREATE INDEX "GeoFlowTaskLink_geoFlowArticleId_idx" ON "GeoFlowTaskLink"("geoFlowArticleId");

-- CreateIndex
CREATE INDEX "GeoFlowTaskLink_status_idx" ON "GeoFlowTaskLink"("status");

-- CreateIndex
CREATE INDEX "GeoFlowTaskLink_lastSyncedAt_idx" ON "GeoFlowTaskLink"("lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GeoFlowTaskLink_idempotencyKey_key" ON "GeoFlowTaskLink"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GeoFlowSyncRun_startedAt_idx" ON "GeoFlowSyncRun"("startedAt");

-- AddForeignKey
ALTER TABLE "GeoFlowTaskLink" ADD CONSTRAINT "GeoFlowTaskLink_contentAssetId_fkey" FOREIGN KEY ("contentAssetId") REFERENCES "ContentAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
