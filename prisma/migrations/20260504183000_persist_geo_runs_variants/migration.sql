-- Persist GEO audit runs and channel variants instead of keeping them only in process memory.

CREATE TABLE "GeoRun" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "contentAssetId" TEXT,
  "prompt" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "competitors" TEXT[] NOT NULL,
  "modelAnswer" TEXT NOT NULL,
  "brandMentioned" BOOLEAN NOT NULL,
  "citedDomains" TEXT[] NOT NULL,
  "score" INTEGER NOT NULL,
  "recommendations" JSONB NOT NULL,
  "mode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GeoRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelVariant" (
  "id" TEXT NOT NULL,
  "contentAssetId" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "copy" TEXT NOT NULL,
  "mediaAssets" TEXT[] NOT NULL,
  "scheduledAt" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChannelVariant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GeoRun_projectId_idx" ON "GeoRun"("projectId");
CREATE INDEX "GeoRun_contentAssetId_idx" ON "GeoRun"("contentAssetId");
CREATE INDEX "GeoRun_provider_idx" ON "GeoRun"("provider");
CREATE INDEX "GeoRun_createdAt_idx" ON "GeoRun"("createdAt");

CREATE INDEX "ChannelVariant_contentAssetId_idx" ON "ChannelVariant"("contentAssetId");
CREATE INDEX "ChannelVariant_platform_idx" ON "ChannelVariant"("platform");
CREATE INDEX "ChannelVariant_status_idx" ON "ChannelVariant"("status");
CREATE INDEX "ChannelVariant_scheduledAt_idx" ON "ChannelVariant"("scheduledAt");

ALTER TABLE "GeoRun"
  ADD CONSTRAINT "GeoRun_contentAssetId_fkey"
  FOREIGN KEY ("contentAssetId") REFERENCES "ContentAsset"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ChannelVariant"
  ADD CONSTRAINT "ChannelVariant_contentAssetId_fkey"
  FOREIGN KEY ("contentAssetId") REFERENCES "ContentAsset"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
