-- Phase 3 starts with additive GEO monitoring storage. Existing analysis runs
-- remain valid because provider metadata is nullable until a real GEO run sets it.

ALTER TABLE "AnalysisRun"
  ADD COLUMN "promptId" TEXT,
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "model" TEXT,
  ADD COLUMN "surface" TEXT,
  ADD COLUMN "latencyMs" INTEGER,
  ADD COLUMN "inputTokens" INTEGER,
  ADD COLUMN "outputTokens" INTEGER,
  ADD COLUMN "costUsd" DECIMAL(18,6);

CREATE TABLE "Prompt" (
  "id" TEXT NOT NULL,
  "siteMarketId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "intent" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "providers" TEXT[] NOT NULL,
  "searchEnabled" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "schedule" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Prompt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderBudget" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "dailyRequestLimit" INTEGER NOT NULL,
  "dailyTokenLimit" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProviderBudget_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderUsage" (
  "id" TEXT NOT NULL,
  "budgetId" TEXT NOT NULL,
  "usageDate" DATE NOT NULL,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DECIMAL(18,6) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProviderUsage_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Prompt"
  ADD CONSTRAINT "Prompt_version_positive" CHECK ("version" >= 1);
ALTER TABLE "ProviderBudget"
  ADD CONSTRAINT "ProviderBudget_request_limit_nonnegative" CHECK ("dailyRequestLimit" >= 0),
  ADD CONSTRAINT "ProviderBudget_token_limit_nonnegative" CHECK ("dailyTokenLimit" IS NULL OR "dailyTokenLimit" >= 0);
ALTER TABLE "ProviderUsage"
  ADD CONSTRAINT "ProviderUsage_counts_nonnegative" CHECK (
    "requestCount" >= 0 AND "inputTokens" >= 0 AND "outputTokens" >= 0 AND "costUsd" >= 0
  );
ALTER TABLE "AnalysisRun"
  ADD CONSTRAINT "AnalysisRun_geo_counts_nonnegative" CHECK (
    ("latencyMs" IS NULL OR "latencyMs" >= 0) AND
    ("inputTokens" IS NULL OR "inputTokens" >= 0) AND
    ("outputTokens" IS NULL OR "outputTokens" >= 0) AND
    ("costUsd" IS NULL OR "costUsd" >= 0)
  );

CREATE UNIQUE INDEX "ProviderBudget_clientId_provider_key"
  ON "ProviderBudget"("clientId", "provider");
CREATE UNIQUE INDEX "ProviderUsage_budgetId_usageDate_key"
  ON "ProviderUsage"("budgetId", "usageDate");
CREATE INDEX "Prompt_siteMarketId_active_idx"
  ON "Prompt"("siteMarketId", "active");
CREATE INDEX "AnalysisRun_promptId_idx"
  ON "AnalysisRun"("promptId");
CREATE INDEX "AnalysisRun_siteMarketId_provider_finishedAt_idx"
  ON "AnalysisRun"("siteMarketId", "provider", "finishedAt");

ALTER TABLE "Prompt"
  ADD CONSTRAINT "Prompt_siteMarketId_fkey"
  FOREIGN KEY ("siteMarketId") REFERENCES "SiteMarket"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderBudget"
  ADD CONSTRAINT "ProviderBudget_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderUsage"
  ADD CONSTRAINT "ProviderUsage_budgetId_fkey"
  FOREIGN KEY ("budgetId") REFERENCES "ProviderBudget"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalysisRun"
  ADD CONSTRAINT "AnalysisRun_promptId_fkey"
  FOREIGN KEY ("promptId") REFERENCES "Prompt"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
