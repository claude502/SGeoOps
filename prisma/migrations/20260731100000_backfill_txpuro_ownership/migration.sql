BEGIN;

-- Fixed platform root for the legacy Txpuro workload. These inserts are
-- intentionally idempotent; assertions below reject conflicting fixed IDs.
INSERT INTO "Workspace" (
  "id", "name", "slug", "createdAt", "updatedAt"
) VALUES (
  'workspace_internal',
  'Internal GEO SEO Operations',
  'internal',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Client" (
  "id", "workspaceId", "name", "slug", "active", "createdAt", "updatedAt"
) VALUES (
  'client_wing_heng',
  'workspace_internal',
  'Wing Heng Technology',
  'wing-heng',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Brand" (
  "id", "clientId", "name", "slug", "aliases", "riskCategory",
  "createdAt", "updatedAt"
) VALUES (
  'brand_txpuro',
  'client_wing_heng',
  'Txpuro',
  'txpuro',
  ARRAY['Txpuro', '智慧电子发票系统 Txpuro'],
  'standard',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Site" (
  "id", "brandId", "name", "canonicalHost", "originHosts", "siteType",
  "hostingMode", "canonicalRules", "allowedPublishPaths", "active",
  "createdAt", "updatedAt"
) VALUES (
  'site_txpuro_com',
  'brand_txpuro',
  'Txpuro.com',
  'txpuro.com',
  ARRAY['geo-origin.winghengtech.com'],
  'content',
  'hybrid',
  '{"https":true,"www":"redirect"}'::jsonb,
  ARRAY['/guides'],
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "SiteMarket" (
  "id", "siteId", "country", "locale", "defaultDevice", "timezone",
  "settings", "createdAt", "updatedAt"
) VALUES
(
  'site_market_txpuro_my_zh_cn',
  'site_txpuro_com',
  'MY',
  'zh-CN',
  'desktop',
  'Asia/Kuala_Lumpur',
  '{"searchEngine":"google.com.my","device":"desktop"}'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
),
(
  'site_market_txpuro_my_en',
  'site_txpuro_com',
  'MY',
  'en',
  'desktop',
  'Asia/Kuala_Lumpur',
  '{"searchEngine":"google.com.my","device":"desktop"}'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "Workspace"
    WHERE "id" = 'workspace_internal'
      AND "name" = 'Internal GEO SEO Operations'
      AND "slug" = 'internal'
  ) THEN
    RAISE EXCEPTION
      'fixed ownership conflict: workspace_internal does not match Txpuro backfill';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "Client"
    WHERE "id" = 'client_wing_heng'
      AND "workspaceId" = 'workspace_internal'
      AND "name" = 'Wing Heng Technology'
      AND "slug" = 'wing-heng'
  ) THEN
    RAISE EXCEPTION
      'fixed ownership conflict: client_wing_heng does not match Txpuro backfill';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "Brand"
    WHERE "id" = 'brand_txpuro'
      AND "clientId" = 'client_wing_heng'
      AND "name" = 'Txpuro'
      AND "slug" = 'txpuro'
      AND "aliases" = ARRAY['Txpuro', '智慧电子发票系统 Txpuro']
      AND "riskCategory" = 'standard'
  ) THEN
    RAISE EXCEPTION
      'fixed ownership conflict: brand_txpuro does not match Txpuro backfill';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "Site"
    WHERE "id" = 'site_txpuro_com'
      AND "brandId" = 'brand_txpuro'
      AND "canonicalHost" = 'txpuro.com'
      AND "originHosts" = ARRAY['geo-origin.winghengtech.com']
      AND "siteType" = 'content'
      AND "hostingMode" = 'hybrid'
      AND "canonicalRules" = '{"https":true,"www":"redirect"}'::jsonb
      AND "allowedPublishPaths" = ARRAY['/guides']
  ) THEN
    RAISE EXCEPTION
      'fixed ownership conflict: site_txpuro_com does not match Txpuro backfill';
  END IF;

  IF (
    SELECT count(*)
    FROM "SiteMarket"
    WHERE (
      "id" = 'site_market_txpuro_my_zh_cn'
      AND "siteId" = 'site_txpuro_com'
      AND "country" = 'MY'
      AND "locale" = 'zh-CN'
      AND "defaultDevice" = 'desktop'
      AND "timezone" = 'Asia/Kuala_Lumpur'
    ) OR (
      "id" = 'site_market_txpuro_my_en'
      AND "siteId" = 'site_txpuro_com'
      AND "country" = 'MY'
      AND "locale" = 'en'
      AND "defaultDevice" = 'desktop'
      AND "timezone" = 'Asia/Kuala_Lumpur'
    )
  ) <> 2 THEN
    RAISE EXCEPTION
      'fixed ownership conflict: Txpuro MY market rows do not match backfill';
  END IF;
END
$$;

-- An expanded legacy row must be wholly unowned or already have a complete
-- root tuple. Never overwrite a partially assigned tenant tuple.
DO $$
DECLARE
  candidate record;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ContentAsset', 'GeoRun', 'ChannelVariant', 'GeoFlowTaskLink',
    'GeoFlowSyncRun', 'AuditEvent', 'TrendTopic', 'VariantMetric',
    'SeoAudit', 'KeywordRanking', 'ExportPackage',
    'DistributionDispatch', 'EventDelivery'
  ]
  LOOP
    EXECUTE format(
      'SELECT "id" FROM %I
       WHERE num_nonnulls("clientId", "brandId", "siteId") BETWEEN 1 AND 2
       ORDER BY "id" LIMIT 1',
      table_name
    ) INTO candidate;
    IF candidate."id" IS NOT NULL THEN
      RAISE EXCEPTION
        'partial ownership tuple in % row %', table_name, candidate."id";
    END IF;
    candidate := NULL;
  END LOOP;
END
$$;

-- Content is the root of most legacy relationships. Validate both required
-- URL signals without rewriting them. Validation is case-insensitive and
-- accepts only http/https, optional canonical www, and numeric ports.
DO $$
DECLARE
  unsafe_id text;
BEGIN
  SELECT "id"
  INTO unsafe_id
  FROM "ContentAsset"
  WHERE "clientId" IS NULL
    AND (
      "canonicalUrl" !~* '^https?://((www\.)?txpuro\.com|geo-origin\.winghengtech\.com)(:[0-9]{1,5})?([/?#]|$)'
      OR "sourceUrl" !~* '^https?://((www\.)?txpuro\.com|geo-origin\.winghengtech\.com)(:[0-9]{1,5})?([/?#]|$)'
      OR "publishTarget" NOT IN ('txpuro', 'geo_ops_internal')
      OR "locale" NOT IN ('zh-CN', 'en')
    )
  ORDER BY "id"
  LIMIT 1;

  IF unsafe_id IS NOT NULL THEN
    RAISE EXCEPTION
      'unsafe ContentAsset URL or scope signal for id %; Txpuro backfill stopped',
      unsafe_id;
  END IF;
END
$$;

UPDATE "ContentAsset"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com',
  "siteMarketId" = CASE "locale"
    WHEN 'en' THEN 'site_market_txpuro_my_en'
    WHEN 'zh-CN' THEN 'site_market_txpuro_my_zh_cn'
  END
WHERE "clientId" IS NULL
  AND "brandId" IS NULL
  AND "siteId" IS NULL;

-- Direct ContentAsset descendants inherit the verified parent tuple.
UPDATE "GeoRun" child
SET
  "clientId" = parent."clientId",
  "brandId" = parent."brandId",
  "siteId" = parent."siteId",
  "siteMarketId" = parent."siteMarketId"
FROM "ContentAsset" parent
WHERE child."contentAssetId" = parent."id"
  AND child."clientId" IS NULL
  AND child."brandId" IS NULL
  AND child."siteId" IS NULL;

DO $$
DECLARE
  unsafe_id text;
BEGIN
  SELECT "id"
  INTO unsafe_id
  FROM "GeoRun"
  WHERE "contentAssetId" IS NULL
    AND "clientId" IS NULL
    AND lower(trim("projectId")) NOT IN (
      'txpuro', 'txpuro.com', 'brand_txpuro', 'site_txpuro_com'
    )
  ORDER BY "id"
  LIMIT 1;

  IF unsafe_id IS NOT NULL THEN
    RAISE EXCEPTION
      'unmatched GeoRun project for id %; Txpuro backfill stopped', unsafe_id;
  END IF;
END
$$;

UPDATE "GeoRun"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com',
  "siteMarketId" = CASE "locale"
    WHEN 'en' THEN 'site_market_txpuro_my_en'
    WHEN 'zh-CN' THEN 'site_market_txpuro_my_zh_cn'
    ELSE NULL
  END
WHERE "contentAssetId" IS NULL
  AND "clientId" IS NULL
  AND "brandId" IS NULL
  AND "siteId" IS NULL
  AND lower(trim("projectId")) IN (
    'txpuro', 'txpuro.com', 'brand_txpuro', 'site_txpuro_com'
  );

UPDATE "ChannelVariant" child
SET
  "clientId" = parent."clientId",
  "brandId" = parent."brandId",
  "siteId" = parent."siteId",
  "siteMarketId" = parent."siteMarketId"
FROM "ContentAsset" parent
WHERE child."contentAssetId" = parent."id"
  AND child."clientId" IS NULL
  AND child."brandId" IS NULL
  AND child."siteId" IS NULL;

UPDATE "GeoFlowTaskLink" child
SET
  "clientId" = parent."clientId",
  "brandId" = parent."brandId",
  "siteId" = parent."siteId",
  "siteMarketId" = parent."siteMarketId"
FROM "ContentAsset" parent
WHERE child."contentAssetId" = parent."id"
  AND child."clientId" IS NULL
  AND child."brandId" IS NULL
  AND child."siteId" IS NULL;

WITH topic_scope AS (
  SELECT
    asset."trendTopicId",
    min(asset."clientId") AS "clientId",
    min(asset."brandId") AS "brandId",
    min(asset."siteId") AS "siteId",
    CASE
      WHEN count(DISTINCT asset."siteMarketId") = 1
      THEN min(asset."siteMarketId")
      ELSE NULL
    END AS "siteMarketId"
  FROM "ContentAsset" asset
  WHERE asset."trendTopicId" IS NOT NULL
  GROUP BY asset."trendTopicId"
)
UPDATE "TrendTopic" topic
SET
  "clientId" = scope."clientId",
  "brandId" = scope."brandId",
  "siteId" = scope."siteId",
  "siteMarketId" = scope."siteMarketId"
FROM topic_scope scope
WHERE topic."id" = scope."trendTopicId"
  AND topic."clientId" IS NULL
  AND topic."brandId" IS NULL
  AND topic."siteId" IS NULL;

-- Unlinked legacy topics and sync runs are intentional site-level operations.
UPDATE "TrendTopic"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com',
  "siteMarketId" = NULL
WHERE "clientId" IS NULL
  AND "brandId" IS NULL
  AND "siteId" IS NULL;

UPDATE "VariantMetric" metric
SET
  "clientId" = variant."clientId",
  "brandId" = variant."brandId",
  "siteId" = variant."siteId",
  "siteMarketId" = variant."siteMarketId"
FROM "ChannelVariant" variant
WHERE metric."channelVariantId" = variant."id"
  AND metric."clientId" IS NULL
  AND metric."brandId" IS NULL
  AND metric."siteId" IS NULL;

UPDATE "ExportPackage" package
SET
  "clientId" = asset."clientId",
  "brandId" = asset."brandId",
  "siteId" = asset."siteId",
  "siteMarketId" = asset."siteMarketId"
FROM "ContentAsset" asset
WHERE package."contentAssetId" = asset."id"
  AND package."clientId" IS NULL
  AND package."brandId" IS NULL
  AND package."siteId" IS NULL;

UPDATE "DistributionDispatch" dispatch
SET
  "clientId" = asset."clientId",
  "brandId" = asset."brandId",
  "siteId" = asset."siteId",
  "siteMarketId" = asset."siteMarketId"
FROM "ContentAsset" asset
WHERE dispatch."contentAssetId" = asset."id"
  AND dispatch."clientId" IS NULL
  AND dispatch."brandId" IS NULL
  AND dispatch."siteId" IS NULL;

DO $$
DECLARE
  unsafe_id text;
BEGIN
  SELECT dispatch."id"
  INTO unsafe_id
  FROM "DistributionDispatch" dispatch
  JOIN "ExportPackage" package ON package."id" = dispatch."exportPackageId"
  WHERE (
    dispatch."clientId",
    dispatch."brandId",
    dispatch."siteId"
  ) IS DISTINCT FROM (
    package."clientId",
    package."brandId",
    package."siteId"
  )
  ORDER BY dispatch."id"
  LIMIT 1;

  IF unsafe_id IS NOT NULL THEN
    RAISE EXCEPTION
      'DistributionDispatch % disagrees with its ExportPackage ownership',
      unsafe_id;
  END IF;
END
$$;

-- URL-only rows have no trustworthy relationship path. Normalize host
-- semantics during validation (case, optional www, and port) but preserve the
-- original text byte-for-byte.
DO $$
DECLARE
  unsafe_id text;
BEGIN
  SELECT "id"
  INTO unsafe_id
  FROM "SeoAudit"
  WHERE "clientId" IS NULL
    AND "url" !~* '^https?://((www\.)?txpuro\.com|geo-origin\.winghengtech\.com)(:[0-9]{1,5})?([/?#]|$)'
  ORDER BY "id"
  LIMIT 1;

  IF unsafe_id IS NOT NULL THEN
    RAISE EXCEPTION
      'unsafe SeoAudit URL for id %; Txpuro backfill stopped', unsafe_id;
  END IF;
END
$$;

UPDATE "SeoAudit"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com',
  "siteMarketId" = CASE
    WHEN "url" ~* '^https?://[^/?#]+/(guides/)?en(/|[?#]|$)'
      THEN 'site_market_txpuro_my_en'
    WHEN "url" ~* '^https?://[^/?#]+/(guides/)?zh(-cn)?(/|[?#]|$)'
      THEN 'site_market_txpuro_my_zh_cn'
    ELSE NULL
  END
WHERE "clientId" IS NULL
  AND "brandId" IS NULL
  AND "siteId" IS NULL;

DO $$
DECLARE
  unsafe_id text;
BEGIN
  SELECT "id"
  INTO unsafe_id
  FROM "KeywordRanking"
  WHERE "clientId" IS NULL
    AND "url" !~* '^https?://((www\.)?txpuro\.com|geo-origin\.winghengtech\.com)(:[0-9]{1,5})?([/?#]|$)'
  ORDER BY "id"
  LIMIT 1;

  IF unsafe_id IS NOT NULL THEN
    RAISE EXCEPTION
      'unsafe KeywordRanking URL for id %; Txpuro backfill stopped', unsafe_id;
  END IF;
END
$$;

UPDATE "KeywordRanking"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com',
  "siteMarketId" = CASE
    WHEN "url" ~* '^https?://[^/?#]+/(guides/)?en(/|[?#]|$)'
      THEN 'site_market_txpuro_my_en'
    WHEN "url" ~* '^https?://[^/?#]+/(guides/)?zh(-cn)?(/|[?#]|$)'
      THEN 'site_market_txpuro_my_zh_cn'
    ELSE NULL
  END
WHERE "clientId" IS NULL
  AND "brandId" IS NULL
  AND "siteId" IS NULL;

UPDATE "GeoFlowSyncRun"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com',
  "siteMarketId" = NULL
WHERE "clientId" IS NULL
  AND "brandId" IS NULL
  AND "siteId" IS NULL;

-- Audit and delivery ownership is derived from a referenced legacy entity
-- when possible. Unknown legacy entity types are deterministic site-level
-- operations and intentionally keep siteMarketId NULL.
WITH entity_scope AS (
  SELECT 'contentasset' AS entity_type, "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "ContentAsset"
  UNION ALL
  SELECT 'georun', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "GeoRun"
  UNION ALL
  SELECT 'channelvariant', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "ChannelVariant"
  UNION ALL
  SELECT 'geoflowtasklink', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "GeoFlowTaskLink"
  UNION ALL
  SELECT 'geoflowsyncrun', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "GeoFlowSyncRun"
  UNION ALL
  SELECT 'trendtopic', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "TrendTopic"
  UNION ALL
  SELECT 'variantmetric', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "VariantMetric"
  UNION ALL
  SELECT 'seoaudit', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "SeoAudit"
  UNION ALL
  SELECT 'keywordranking', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "KeywordRanking"
  UNION ALL
  SELECT 'exportpackage', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "ExportPackage"
  UNION ALL
  SELECT 'distributiondispatch', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "DistributionDispatch"
  UNION ALL
  SELECT 'eventdelivery', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "EventDelivery"
)
UPDATE "AuditEvent" audit
SET
  "clientId" = scope."clientId",
  "brandId" = scope."brandId",
  "siteId" = scope."siteId",
  "siteMarketId" = scope."siteMarketId"
FROM entity_scope scope
WHERE lower(audit."entityType") = scope.entity_type
  AND audit."entityId" = scope."id"
  AND audit."clientId" IS NULL
  AND audit."brandId" IS NULL
  AND audit."siteId" IS NULL;

UPDATE "AuditEvent"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com',
  "siteMarketId" = NULL
WHERE "clientId" IS NULL
  AND "brandId" IS NULL
  AND "siteId" IS NULL;

WITH entity_scope AS (
  SELECT 'contentasset' AS entity_type, "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "ContentAsset"
  UNION ALL
  SELECT 'georun', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "GeoRun"
  UNION ALL
  SELECT 'channelvariant', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "ChannelVariant"
  UNION ALL
  SELECT 'geoflowtasklink', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "GeoFlowTaskLink"
  UNION ALL
  SELECT 'geoflowsyncrun', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "GeoFlowSyncRun"
  UNION ALL
  SELECT 'auditevent', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "AuditEvent"
  UNION ALL
  SELECT 'trendtopic', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "TrendTopic"
  UNION ALL
  SELECT 'variantmetric', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "VariantMetric"
  UNION ALL
  SELECT 'seoaudit', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "SeoAudit"
  UNION ALL
  SELECT 'keywordranking', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "KeywordRanking"
  UNION ALL
  SELECT 'exportpackage', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "ExportPackage"
  UNION ALL
  SELECT 'distributiondispatch', "id", "clientId", "brandId", "siteId", "siteMarketId"
  FROM "DistributionDispatch"
)
UPDATE "EventDelivery" delivery
SET
  "clientId" = scope."clientId",
  "brandId" = scope."brandId",
  "siteId" = scope."siteId",
  "siteMarketId" = scope."siteMarketId"
FROM entity_scope scope
WHERE lower(delivery."entityType") = scope.entity_type
  AND delivery."entityId" = scope."id"
  AND delivery."clientId" IS NULL
  AND delivery."brandId" IS NULL
  AND delivery."siteId" IS NULL;

UPDATE "EventDelivery"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com',
  "siteMarketId" = NULL
WHERE "clientId" IS NULL
  AND "brandId" IS NULL
  AND "siteId" IS NULL;

-- Every legacy table must have a complete root tuple before the enforce phase.
DO $$
DECLARE
  orphan_id text;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ContentAsset', 'GeoRun', 'ChannelVariant', 'GeoFlowTaskLink',
    'GeoFlowSyncRun', 'AuditEvent', 'TrendTopic', 'VariantMetric',
    'SeoAudit', 'KeywordRanking', 'ExportPackage',
    'DistributionDispatch', 'EventDelivery'
  ]
  LOOP
    EXECUTE format(
      'SELECT "id" FROM %I
       WHERE "clientId" IS NULL OR "brandId" IS NULL OR "siteId" IS NULL
       ORDER BY "id" LIMIT 1',
      table_name
    ) INTO orphan_id;
    IF orphan_id IS NOT NULL THEN
      RAISE EXCEPTION
        'ownership backfill orphan in % row %', table_name, orphan_id;
    END IF;
    orphan_id := NULL;
  END LOOP;
END
$$;

COMMIT;
