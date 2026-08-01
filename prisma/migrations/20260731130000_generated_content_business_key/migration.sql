-- Signed content generation uses this key to claim one generated asset before
-- variants and required events are written. PostgreSQL permits duplicate rows
-- when either nullable source field is NULL, preserving non-generated assets.
-- Old concurrent writers could have created duplicate generated rows. Keep the
-- earliest row as the business-key canonical and quarantine later rows by ID
-- so their dependent data and foreign-key relationships remain intact.
WITH RECURSIVE ranked_generated_assets AS (
  SELECT
    "id",
    "clientId",
    "sourceSystem",
    "trendTopicId",
    "templateId",
    row_number() OVER (
      PARTITION BY "clientId", "sourceSystem", "trendTopicId", "templateId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS rank
  FROM "ContentAsset"
  WHERE "trendTopicId" IS NOT NULL
    AND "templateId" IS NOT NULL
),
duplicate_assets AS (
  SELECT
    "id",
    "clientId",
    "sourceSystem",
    "trendTopicId",
    '__sgeo_quarantine__template:' || char_length("templateId")::text ||
      ':' || "templateId" || ':asset:' || char_length("id")::text ||
      ':' || "id" AS candidate_base
  FROM ranked_generated_assets
  WHERE rank > 1
),
quarantine_candidates AS (
  SELECT
    "id",
    "clientId",
    "sourceSystem",
    "trendTopicId",
    candidate_base,
    0::integer AS attempt,
    candidate_base || ':attempt:0' AS candidate
  FROM duplicate_assets

  UNION ALL

  SELECT
    candidate."id",
    candidate."clientId",
    candidate."sourceSystem",
    candidate."trendTopicId",
    candidate.candidate_base,
    candidate.attempt + 1,
    candidate.candidate_base || ':attempt:' || (candidate.attempt + 1)::text
  FROM quarantine_candidates AS candidate
  WHERE EXISTS (
    SELECT 1
    FROM "ContentAsset" AS occupied
    WHERE occupied."clientId" = candidate."clientId"
      AND occupied."sourceSystem" = candidate."sourceSystem"
      AND occupied."trendTopicId" = candidate."trendTopicId"
      AND occupied."templateId" = candidate.candidate
  )
),
quarantine_assignments AS (
  SELECT candidate."id", candidate.candidate
  FROM quarantine_candidates AS candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM "ContentAsset" AS occupied
    WHERE occupied."clientId" = candidate."clientId"
      AND occupied."sourceSystem" = candidate."sourceSystem"
      AND occupied."trendTopicId" = candidate."trendTopicId"
      AND occupied."templateId" = candidate.candidate
  )
)
UPDATE "ContentAsset" AS duplicate
SET "templateId" = quarantine_assignments.candidate
FROM quarantine_assignments
WHERE duplicate."id" = quarantine_assignments."id";

CREATE UNIQUE INDEX "ContentAsset_clientId_sourceSystem_trendTopicId_templateId_key"
  ON "ContentAsset"("clientId", "sourceSystem", "trendTopicId", "templateId");
