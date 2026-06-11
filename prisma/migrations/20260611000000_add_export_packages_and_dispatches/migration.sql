-- CreateEnum
CREATE TYPE "ExportPackageStatus" AS ENUM ('ready', 'claimed', 'dispatched', 'failed', 'archived');

-- CreateEnum
CREATE TYPE "DistributionDispatchStatus" AS ENUM ('accepted', 'scheduled', 'published', 'failed', 'deleted');

-- CreateEnum
CREATE TYPE "EventDeliveryStatus" AS ENUM ('pending', 'sent', 'failed', 'abandoned');

-- CreateTable
CREATE TABLE "ExportPackage" (
    "id" TEXT NOT NULL,
    "contentAssetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "language" TEXT NOT NULL DEFAULT 'zh-CN',
    "status" "ExportPackageStatus" NOT NULL DEFAULT 'ready',
    "packageType" TEXT NOT NULL,
    "payload" JSONB,
    "recommendedPlatforms" TEXT[],
    "sourceUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExportPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributionDispatch" (
    "id" TEXT NOT NULL,
    "exportPackageId" TEXT NOT NULL,
    "contentAssetId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "externalPostId" TEXT,
    "publishedUrl" TEXT,
    "status" "DistributionDispatchStatus" NOT NULL DEFAULT 'accepted',
    "errorMessage" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DistributionDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventDelivery" (
    "id" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB,
    "target" TEXT NOT NULL,
    "status" "EventDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentAsset_sourceSystem_trendTopicId_templateId_locale_idx" ON "ContentAsset"("sourceSystem", "trendTopicId", "templateId", "locale");

-- CreateIndex
CREATE INDEX "ExportPackage_contentAssetId_idx" ON "ExportPackage"("contentAssetId");

-- CreateIndex
CREATE INDEX "ExportPackage_status_idx" ON "ExportPackage"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ExportPackage_contentAssetId_version_language_key" ON "ExportPackage"("contentAssetId", "version", "language");

-- CreateIndex
CREATE INDEX "DistributionDispatch_exportPackageId_idx" ON "DistributionDispatch"("exportPackageId");

-- CreateIndex
CREATE INDEX "DistributionDispatch_contentAssetId_idx" ON "DistributionDispatch"("contentAssetId");

-- CreateIndex
CREATE INDEX "DistributionDispatch_platform_status_idx" ON "DistributionDispatch"("platform", "status");

-- CreateIndex
CREATE INDEX "EventDelivery_eventName_status_idx" ON "EventDelivery"("eventName", "status");

-- CreateIndex
CREATE INDEX "EventDelivery_entityType_entityId_idx" ON "EventDelivery"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "EventDelivery_createdAt_idx" ON "EventDelivery"("createdAt");

-- AddForeignKey
ALTER TABLE "ExportPackage" ADD CONSTRAINT "ExportPackage_contentAssetId_fkey" FOREIGN KEY ("contentAssetId") REFERENCES "ContentAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionDispatch" ADD CONSTRAINT "DistributionDispatch_exportPackageId_fkey" FOREIGN KEY ("exportPackageId") REFERENCES "ExportPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionDispatch" ADD CONSTRAINT "DistributionDispatch_contentAssetId_fkey" FOREIGN KEY ("contentAssetId") REFERENCES "ContentAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
