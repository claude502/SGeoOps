-- Signed content generation uses this key to claim one generated asset before
-- variants and required events are written. PostgreSQL permits duplicate rows
-- when either nullable source field is NULL, preserving non-generated assets.
CREATE UNIQUE INDEX "ContentAsset_clientId_sourceSystem_trendTopicId_templateId_key"
  ON "ContentAsset"("clientId", "sourceSystem", "trendTopicId", "templateId");
