-- CreateIndex: prevent duplicate keyword+platform entries in TrendTopic.
-- The trend-crawl job uses upsert on this constraint to refresh scores
-- instead of accumulating identical rows every 15 minutes.
CREATE UNIQUE INDEX "TrendTopic_keyword_platform_key" ON "TrendTopic"("keyword", "platform");
