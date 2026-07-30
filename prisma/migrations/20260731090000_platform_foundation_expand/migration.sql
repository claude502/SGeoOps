-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('Admin', 'Operator', 'Reviewer', 'Viewer');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'succeeded', 'partial', 'retrying', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "siteMarketId" TEXT;

-- AlterTable
ALTER TABLE "ChannelVariant" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "siteMarketId" TEXT;

-- AlterTable
ALTER TABLE "ContentAsset" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "siteMarketId" TEXT;

-- AlterTable
ALTER TABLE "DistributionDispatch" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "siteMarketId" TEXT;

-- AlterTable
ALTER TABLE "EventDelivery" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "siteMarketId" TEXT;

-- AlterTable
ALTER TABLE "ExportPackage" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "siteMarketId" TEXT;

-- AlterTable
ALTER TABLE "GeoFlowSyncRun" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "siteMarketId" TEXT;

-- AlterTable
ALTER TABLE "GeoFlowTaskLink" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "siteMarketId" TEXT;

-- AlterTable
ALTER TABLE "GeoRun" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "siteMarketId" TEXT;

-- AlterTable
ALTER TABLE "KeywordRanking" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "siteMarketId" TEXT;

-- AlterTable
ALTER TABLE "SeoAudit" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "siteMarketId" TEXT;

-- AlterTable
ALTER TABLE "TrendTopic" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "siteMarketId" TEXT;

-- AlterTable
ALTER TABLE "VariantMetric" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "siteMarketId" TEXT;

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "aliases" TEXT[],
    "products" JSONB,
    "industry" TEXT,
    "goals" JSONB,
    "riskCategory" TEXT NOT NULL DEFAULT 'standard',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "canonicalHost" TEXT NOT NULL,
    "originHosts" TEXT[],
    "siteType" TEXT NOT NULL,
    "hostingMode" TEXT NOT NULL,
    "canonicalRules" JSONB NOT NULL,
    "allowedPublishPaths" TEXT[],
    "ownershipVerifiedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteMarket" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "defaultDevice" TEXT NOT NULL DEFAULT 'desktop',
    "timezone" TEXT NOT NULL,
    "settings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteMarket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Competitor" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "siteMarketId" TEXT,
    "name" TEXT NOT NULL,
    "aliases" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Competitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Keyword" (
    "id" TEXT NOT NULL,
    "siteMarketId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "targetUrl" TEXT,
    "country" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '*',
    "priority" INTEGER NOT NULL DEFAULT 3,
    "schedule" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Keyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "siteMarketId" TEXT,
    "type" TEXT NOT NULL,
    "endpoint" TEXT,
    "capabilities" TEXT[],
    "adapterVersion" TEXT NOT NULL,
    "secretRef" TEXT,
    "healthState" TEXT NOT NULL DEFAULT 'unknown',
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "siteMarketId" TEXT,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL,
    "inputHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawArtifact" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "retentionAt" TIMESTAMP(3) NOT NULL,
    "redacted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Observation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "surface" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "promptVersion" INTEGER,
    "country" TEXT,
    "locale" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" DECIMAL(18,6) NOT NULL,
    "dimensions" JSONB NOT NULL,
    "formulaVersion" TEXT NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "priority" DECIMAL(10,4) NOT NULL,
    "formulaVersion" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "ownerId" TEXT,
    "dueAt" TIMESTAMP(3),
    "resolution" TEXT,
    "verificationRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationEvidence" (
    "recommendationId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,

    CONSTRAINT "RecommendationEvidence_pkey" PRIMARY KEY ("recommendationId","observationId")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "priority" DECIMAL(10,4) NOT NULL,
    "formulaVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityRecommendation" (
    "opportunityId" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,

    CONSTRAINT "OpportunityRecommendation_pkey" PRIMARY KEY ("opportunityId","recommendationId")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_role_idx" ON "WorkspaceMember"("userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "Client_workspaceId_active_idx" ON "Client"("workspaceId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Client_workspaceId_slug_key" ON "Client"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "Brand_clientId_idx" ON "Brand"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_clientId_slug_key" ON "Brand"("clientId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Site_canonicalHost_key" ON "Site"("canonicalHost");

-- CreateIndex
CREATE INDEX "Site_brandId_active_idx" ON "Site"("brandId", "active");

-- CreateIndex
CREATE INDEX "SiteMarket_siteId_idx" ON "SiteMarket"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteMarket_siteId_country_locale_key" ON "SiteMarket"("siteId", "country", "locale");

-- CreateIndex
CREATE INDEX "Competitor_brandId_active_idx" ON "Competitor"("brandId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Competitor_brandId_siteMarketId_name_key" ON "Competitor"("brandId", "siteMarketId", "name");

-- CreateIndex
CREATE INDEX "Keyword_siteMarketId_active_idx" ON "Keyword"("siteMarketId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Keyword_siteMarketId_text_country_device_location_key" ON "Keyword"("siteMarketId", "text", "country", "device", "location");

-- CreateIndex
CREATE INDEX "Integration_siteId_healthState_idx" ON "Integration"("siteId", "healthState");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_siteId_siteMarketId_type_key" ON "Integration"("siteId", "siteMarketId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisRun_idempotencyKey_key" ON "AnalysisRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AnalysisRun_siteId_kind_inputHash_idx" ON "AnalysisRun"("siteId", "kind", "inputHash");

-- CreateIndex
CREATE INDEX "AnalysisRun_clientId_siteId_createdAt_idx" ON "AnalysisRun"("clientId", "siteId", "createdAt");

-- CreateIndex
CREATE INDEX "AnalysisRun_status_createdAt_idx" ON "AnalysisRun"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawArtifact_uri_key" ON "RawArtifact"("uri");

-- CreateIndex
CREATE INDEX "RawArtifact_runId_idx" ON "RawArtifact"("runId");

-- CreateIndex
CREATE INDEX "RawArtifact_retentionAt_idx" ON "RawArtifact"("retentionAt");

-- CreateIndex
CREATE INDEX "Observation_runId_kind_idx" ON "Observation"("runId", "kind");

-- CreateIndex
CREATE INDEX "Observation_kind_observedAt_idx" ON "Observation"("kind", "observedAt");

-- CreateIndex
CREATE INDEX "MetricSnapshot_runId_name_idx" ON "MetricSnapshot"("runId", "name");

-- CreateIndex
CREATE INDEX "Recommendation_clientId_siteId_state_idx" ON "Recommendation"("clientId", "siteId", "state");

-- CreateIndex
CREATE INDEX "Opportunity_clientId_siteId_state_idx" ON "Opportunity"("clientId", "siteId", "state");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboxEvent_source_externalId_key" ON "InboxEvent"("source", "externalId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteMarket" ADD CONSTRAINT "SiteMarket_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competitor" ADD CONSTRAINT "Competitor_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competitor" ADD CONSTRAINT "Competitor_siteMarketId_fkey" FOREIGN KEY ("siteMarketId") REFERENCES "SiteMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_siteMarketId_fkey" FOREIGN KEY ("siteMarketId") REFERENCES "SiteMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_siteMarketId_fkey" FOREIGN KEY ("siteMarketId") REFERENCES "SiteMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_siteMarketId_fkey" FOREIGN KEY ("siteMarketId") REFERENCES "SiteMarket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawArtifact" ADD CONSTRAINT "RawArtifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationEvidence" ADD CONSTRAINT "RecommendationEvidence_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationEvidence" ADD CONSTRAINT "RecommendationEvidence_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "Observation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityRecommendation" ADD CONSTRAINT "OpportunityRecommendation_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityRecommendation" ADD CONSTRAINT "OpportunityRecommendation_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
