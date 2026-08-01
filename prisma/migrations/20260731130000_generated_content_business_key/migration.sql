-- Signed content generation uses this key to claim one generated asset before
-- variants and required events are written. PostgreSQL permits duplicate rows
-- when either nullable source field is NULL, preserving non-generated assets.
-- Old concurrent writers could have created duplicate generated rows. Keep the
-- earliest row as the business-key canonical and quarantine later rows by ID
-- so their dependent data and foreign-key relationships remain intact.
WITH ranked_generated_assets AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "clientId", "sourceSystem", "trendTopicId", "templateId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS rank
  FROM "ContentAsset"
  WHERE "trendTopicId" IS NOT NULL
    AND "templateId" IS NOT NULL
)
UPDATE "ContentAsset" AS duplicate
SET "templateId" = duplicate."templateId" || ':duplicate:' || duplicate."id"
FROM ranked_generated_assets
WHERE duplicate."id" = ranked_generated_assets."id"
  AND ranked_generated_assets.rank > 1;

CREATE UNIQUE INDEX "ContentAsset_clientId_sourceSystem_trendTopicId_templateId_key"
  ON "ContentAsset"("clientId", "sourceSystem", "trendTopicId", "templateId");
