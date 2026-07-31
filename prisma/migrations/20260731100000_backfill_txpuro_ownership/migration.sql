BEGIN;

-- SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE lock taken by every
-- INSERT/UPDATE/DELETE and with the ACCESS EXCLUSIVE lock taken by TRUNCATE.
-- Acquire all legacy tables in one fixed declaration order before any scan so
-- concurrent writers cannot create a TOCTOU gap.
LOCK TABLE
  "ContentAsset",
  "GeoRun",
  "ChannelVariant",
  "GeoFlowTaskLink",
  "GeoFlowSyncRun",
  "AuditEvent",
  "TrendTopic",
  "VariantMetric",
  "SeoAudit",
  "KeywordRanking",
  "ExportPackage",
  "DistributionDispatch",
  "EventDelivery"
IN SHARE ROW EXCLUSIVE MODE;

-- A retry of this idempotent migration owns all table locks before removing
-- the gate installed by its previous successful run.
DO $$
DECLARE
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
      'DROP TRIGGER IF EXISTS %I ON %I',
      'ownership_backfill_write_gate_' || table_name,
      table_name
    );
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I',
      'ownership_backfill_truncate_gate_' || table_name,
      table_name
    );
  END LOOP;
END
$$;

DROP FUNCTION IF EXISTS "block_legacy_writes_until_enforced"();

-- This stable resolver is the single alias definition used by both backfill
-- and permanent ownership enforcement. It remains installed across the
-- backfill/enforce transaction boundary.
CREATE OR REPLACE FUNCTION "resolve_legacy_entity_table"(entity_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN CASE
  regexp_replace(lower(btrim(entity_type)), '[^a-z0-9]', '', 'g')
  WHEN 'contentasset' THEN 'ContentAsset'
  WHEN 'contentassets' THEN 'ContentAsset'
  WHEN 'georun' THEN 'GeoRun'
  WHEN 'georuns' THEN 'GeoRun'
  WHEN 'channelvariant' THEN 'ChannelVariant'
  WHEN 'channelvariants' THEN 'ChannelVariant'
  WHEN 'geoflowtasklink' THEN 'GeoFlowTaskLink'
  WHEN 'geoflowtasklinks' THEN 'GeoFlowTaskLink'
  WHEN 'geoflowsyncrun' THEN 'GeoFlowSyncRun'
  WHEN 'geoflowsyncruns' THEN 'GeoFlowSyncRun'
  WHEN 'auditevent' THEN 'AuditEvent'
  WHEN 'auditevents' THEN 'AuditEvent'
  WHEN 'trendtopic' THEN 'TrendTopic'
  WHEN 'trendtopics' THEN 'TrendTopic'
  WHEN 'variantmetric' THEN 'VariantMetric'
  WHEN 'variantmetrics' THEN 'VariantMetric'
  WHEN 'seoaudit' THEN 'SeoAudit'
  WHEN 'seoaudits' THEN 'SeoAudit'
  WHEN 'keywordranking' THEN 'KeywordRanking'
  WHEN 'keywordrankings' THEN 'KeywordRanking'
  WHEN 'exportpackage' THEN 'ExportPackage'
  WHEN 'exportpackages' THEN 'ExportPackage'
  WHEN 'distributiondispatch' THEN 'DistributionDispatch'
  WHEN 'distributiondispatches' THEN 'DistributionDispatch'
  WHEN 'eventdelivery' THEN 'EventDelivery'
  WHEN 'eventdeliveries' THEN 'EventDelivery'
  ELSE NULL
END;

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
  'Txpuro',
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
      AND "active" IS TRUE
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
      AND "products" IS NULL
      AND "industry" IS NULL
      AND "goals" IS NULL
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
      AND "name" = 'Txpuro'
      AND "canonicalHost" = 'txpuro.com'
      AND "originHosts" = ARRAY['geo-origin.winghengtech.com']
      AND "siteType" = 'content'
      AND "hostingMode" = 'hybrid'
      AND "canonicalRules" = '{"https":true,"www":"redirect"}'::jsonb
      AND "allowedPublishPaths" = ARRAY['/guides']
      AND "ownershipVerifiedAt" IS NULL
      AND "active" IS TRUE
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
      AND "settings" =
        '{"searchEngine":"google.com.my","device":"desktop"}'::jsonb
    ) OR (
      "id" = 'site_market_txpuro_my_en'
      AND "siteId" = 'site_txpuro_com'
      AND "country" = 'MY'
      AND "locale" = 'en'
      AND "defaultDevice" = 'desktop'
      AND "timezone" = 'Asia/Kuala_Lumpur'
      AND "settings" =
        '{"searchEngine":"google.com.my","device":"desktop"}'::jsonb
    )
  ) <> 2 THEN
    RAISE EXCEPTION
      'fixed ownership conflict: Txpuro MY market rows do not match backfill';
  END IF;
END
$$;

-- An expanded legacy row must be wholly unowned or already have a complete,
-- internally consistent root tuple. A market is an ownership signal too:
-- unowned rows may only carry one of the two fixed Txpuro markets.
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

    EXECUTE format(
      'SELECT "id" FROM %I
       WHERE num_nonnulls("clientId", "brandId", "siteId") = 0
         AND "siteMarketId" IS NOT NULL
         AND "siteMarketId" NOT IN (
           ''site_market_txpuro_my_zh_cn'',
           ''site_market_txpuro_my_en''
         )
       ORDER BY "id" LIMIT 1',
      table_name
    ) INTO candidate;
    IF candidate."id" IS NOT NULL THEN
      RAISE EXCEPTION
        'invalid market ownership signal in % row %',
        table_name, candidate."id";
    END IF;
    candidate := NULL;

    EXECUTE format(
      'SELECT owned."id"
       FROM %I owned
       LEFT JOIN "Brand" brand ON brand."id" = owned."brandId"
       LEFT JOIN "Site" site ON site."id" = owned."siteId"
       LEFT JOIN "SiteMarket" market ON market."id" = owned."siteMarketId"
       WHERE num_nonnulls(
         owned."clientId", owned."brandId", owned."siteId"
       ) = 3
         AND (
           brand."clientId" IS DISTINCT FROM owned."clientId"
           OR site."brandId" IS DISTINCT FROM owned."brandId"
           OR (
             owned."siteMarketId" IS NOT NULL
             AND market."siteId" IS DISTINCT FROM owned."siteId"
           )
         )
       ORDER BY owned."id" LIMIT 1',
      table_name
    ) INTO candidate;
    IF candidate."id" IS NOT NULL THEN
      RAISE EXCEPTION
        'ownership chain mismatch in % row %',
        table_name, candidate."id";
    END IF;
    candidate := NULL;
  END LOOP;
END
$$;

-- Content is the root of most legacy relationships. An explicit brand signal
-- must normalize to one of the accepted Txpuro names before URL inference.
DO $$
DECLARE
  unsafe_id text;
BEGIN
  SELECT "id"
  INTO unsafe_id
  FROM "ContentAsset"
  WHERE "clientId" IS NULL
    AND (
      regexp_replace(lower(btrim("brandEntity")), '\s+', ' ', 'g') <> ''
      AND regexp_replace(
        lower(btrim("brandEntity")), '\s+', ' ', 'g'
      ) NOT IN (
        'txpuro',
        'txpuro e-invoice system',
        '智慧电子发票系统 txpuro'
      )
    )
  ORDER BY "id"
  LIMIT 1;

  IF unsafe_id IS NOT NULL THEN
    RAISE EXCEPTION
      'unsafe ContentAsset brand signal for id %; Txpuro backfill stopped',
      unsafe_id;
  END IF;
END
$$;

-- Parse every URL ownership signal through one expression. Authority matching
-- is case-insensitive; explicit ports are accepted only in PostgreSQL's valid
-- TCP range. No URL text is normalized or rewritten.
DO $$
DECLARE
  unsafe record;
BEGIN
  WITH url_candidates AS (
    SELECT
      'ContentAsset'::text AS source_table,
      "id" AS row_id,
      'canonicalUrl'::text AS source_column,
      "canonicalUrl" AS candidate_url
    FROM "ContentAsset"
    WHERE "clientId" IS NULL
    UNION ALL
    SELECT 'ContentAsset', "id", 'sourceUrl', "sourceUrl"
    FROM "ContentAsset"
    WHERE "clientId" IS NULL
    UNION ALL
    SELECT 'SeoAudit', "id", 'url', "url"
    FROM "SeoAudit"
    WHERE "clientId" IS NULL
    UNION ALL
    SELECT 'KeywordRanking', "id", 'url', "url"
    FROM "KeywordRanking"
    WHERE "clientId" IS NULL
  ),
  parsed AS (
    SELECT
      source_table,
      row_id,
      source_column,
      candidate_url,
      substring(
        lower(candidate_url) FROM '^https?://([^/?#]+)'
      ) AS authority
    FROM url_candidates
  ),
  authority_parts AS (
    SELECT
      source_table,
      row_id,
      source_column,
      candidate_url,
      authority,
      CASE
        WHEN authority ~ ':[0-9]+$'
        THEN substring(authority FROM ':([0-9]+)$')
        ELSE NULL
      END AS port_text
    FROM parsed
  )
  SELECT source_table, row_id, source_column, candidate_url
  INTO unsafe
  FROM authority_parts
  WHERE authority IS NULL
    OR authority !~
      '^((www\.)?txpuro\.com|geo-origin\.winghengtech\.com)(:[0-9]+)?$'
    OR CASE
      WHEN port_text IS NULL THEN false
      ELSE port_text::numeric NOT BETWEEN 1 AND 65535
    END
  ORDER BY source_table, row_id, source_column
  LIMIT 1;

  IF unsafe.row_id IS NOT NULL THEN
    RAISE EXCEPTION
      'unsafe Txpuro URL: unsafe % URL in % for id %; backfill stopped',
      unsafe.source_table, unsafe.source_column, unsafe.row_id;
  END IF;
END
$$;

DO $$
DECLARE
  unsafe_id text;
BEGIN
  SELECT "id"
  INTO unsafe_id
  FROM "ContentAsset"
  WHERE "clientId" IS NULL
    AND (
      "publishTarget" NOT IN ('txpuro', 'geo_ops_internal')
      OR "locale" NOT IN ('zh-CN', 'en')
    )
  ORDER BY "id"
  LIMIT 1;

  IF unsafe_id IS NOT NULL THEN
    RAISE EXCEPTION
      'unsafe ContentAsset scope signal for id %; Txpuro backfill stopped',
      unsafe_id;
  END IF;
END
$$;

UPDATE "ContentAsset"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com',
  "siteMarketId" = COALESCE(
    "siteMarketId",
    CASE "locale"
      WHEN 'en' THEN 'site_market_txpuro_my_en'
      WHEN 'zh-CN' THEN 'site_market_txpuro_my_zh_cn'
    END
  )
WHERE "clientId" IS NULL
  AND "brandId" IS NULL
  AND "siteId" IS NULL;

-- Direct ContentAsset descendants inherit the verified parent tuple.
UPDATE "GeoRun" child
SET
  "clientId" = parent."clientId",
  "brandId" = parent."brandId",
  "siteId" = parent."siteId",
  "siteMarketId" = COALESCE(child."siteMarketId", parent."siteMarketId")
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
  "siteMarketId" = COALESCE(
    "siteMarketId",
    CASE "locale"
      WHEN 'en' THEN 'site_market_txpuro_my_en'
      WHEN 'zh-CN' THEN 'site_market_txpuro_my_zh_cn'
      ELSE NULL
    END
  )
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
  "siteMarketId" = COALESCE(child."siteMarketId", parent."siteMarketId")
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
  "siteMarketId" = COALESCE(child."siteMarketId", parent."siteMarketId")
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
  "siteMarketId" = COALESCE(topic."siteMarketId", scope."siteMarketId")
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
  "siteId" = 'site_txpuro_com'
WHERE "clientId" IS NULL
  AND "brandId" IS NULL
  AND "siteId" IS NULL;

UPDATE "VariantMetric" metric
SET
  "clientId" = variant."clientId",
  "brandId" = variant."brandId",
  "siteId" = variant."siteId",
  "siteMarketId" = COALESCE(metric."siteMarketId", variant."siteMarketId")
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
  "siteMarketId" = COALESCE(package."siteMarketId", asset."siteMarketId")
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
  "siteMarketId" = COALESCE(dispatch."siteMarketId", asset."siteMarketId")
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

UPDATE "SeoAudit"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com',
  "siteMarketId" = COALESCE(
    "siteMarketId",
    CASE
      WHEN "url" ~* '^https?://[^/?#]+/(guides/)?en(/|[?#]|$)'
        THEN 'site_market_txpuro_my_en'
      WHEN "url" ~* '^https?://[^/?#]+/(guides/)?zh(-cn)?(/|[?#]|$)'
        THEN 'site_market_txpuro_my_zh_cn'
      ELSE NULL
    END
  )
WHERE "clientId" IS NULL
  AND "brandId" IS NULL
  AND "siteId" IS NULL;

UPDATE "KeywordRanking"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com',
  "siteMarketId" = COALESCE(
    "siteMarketId",
    CASE
      WHEN "url" ~* '^https?://[^/?#]+/(guides/)?en(/|[?#]|$)'
        THEN 'site_market_txpuro_my_en'
      WHEN "url" ~* '^https?://[^/?#]+/(guides/)?zh(-cn)?(/|[?#]|$)'
        THEN 'site_market_txpuro_my_zh_cn'
      ELSE NULL
    END
  )
WHERE "clientId" IS NULL
  AND "brandId" IS NULL
  AND "siteId" IS NULL;

UPDATE "GeoFlowSyncRun"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com'
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
  "siteMarketId" = COALESCE(audit."siteMarketId", scope."siteMarketId")
FROM entity_scope scope
WHERE lower("resolve_legacy_entity_table"(audit."entityType")) =
      scope.entity_type
  AND audit."entityId" = scope."id"
  AND audit."clientId" IS NULL
  AND audit."brandId" IS NULL
  AND audit."siteId" IS NULL;

UPDATE "AuditEvent"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com'
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
  "siteMarketId" = COALESCE(delivery."siteMarketId", scope."siteMarketId")
FROM entity_scope scope
WHERE lower("resolve_legacy_entity_table"(delivery."entityType")) =
      scope.entity_type
  AND delivery."entityId" = scope."id"
  AND delivery."clientId" IS NULL
  AND delivery."brandId" IS NULL
  AND delivery."siteId" IS NULL;

UPDATE "EventDelivery"
SET
  "clientId" = 'client_wing_heng',
  "brandId" = 'brand_txpuro',
  "siteId" = 'site_txpuro_com'
WHERE "clientId" IS NULL
  AND "brandId" IS NULL
  AND "siteId" IS NULL;

-- Every legacy table must have a complete root tuple before the enforce phase.
DO $$
DECLARE
  orphan_id text;
  chain_mismatch_id text;
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

    EXECUTE format(
      'SELECT owned."id"
       FROM %I owned
       LEFT JOIN "Brand" brand ON brand."id" = owned."brandId"
       LEFT JOIN "Site" site ON site."id" = owned."siteId"
       LEFT JOIN "SiteMarket" market ON market."id" = owned."siteMarketId"
       WHERE brand."clientId" IS DISTINCT FROM owned."clientId"
          OR site."brandId" IS DISTINCT FROM owned."brandId"
          OR (
            owned."siteMarketId" IS NOT NULL
            AND market."siteId" IS DISTINCT FROM owned."siteId"
          )
       ORDER BY owned."id" LIMIT 1',
      table_name
    ) INTO chain_mismatch_id;
    IF chain_mismatch_id IS NOT NULL THEN
      RAISE EXCEPTION
        'ownership chain after backfill mismatch in % row %',
        table_name, chain_mismatch_id;
    END IF;
    chain_mismatch_id := NULL;
  END LOOP;
END
$$;

-- Validate every concrete legacy relationship before the write gate is
-- installed. Root ownership must match exactly; market scope may differ only
-- when at least one endpoint is intentionally site-level.
DO $$
DECLARE
  mismatch record;
BEGIN
  WITH relationship_pairs AS (
    SELECT
      'ContentAsset'::text AS child_table,
      child."id" AS child_id,
      'TrendTopic'::text AS parent_table,
      parent."id" AS parent_id,
      child."clientId" AS child_client_id,
      child."brandId" AS child_brand_id,
      child."siteId" AS child_site_id,
      child."siteMarketId" AS child_market_id,
      parent."clientId" AS parent_client_id,
      parent."brandId" AS parent_brand_id,
      parent."siteId" AS parent_site_id,
      parent."siteMarketId" AS parent_market_id
    FROM "ContentAsset" child
    JOIN "TrendTopic" parent ON parent."id" = child."trendTopicId"
    UNION ALL
    SELECT
      'GeoRun', child."id", 'ContentAsset', parent."id",
      child."clientId", child."brandId", child."siteId", child."siteMarketId",
      parent."clientId", parent."brandId", parent."siteId", parent."siteMarketId"
    FROM "GeoRun" child
    JOIN "ContentAsset" parent ON parent."id" = child."contentAssetId"
    UNION ALL
    SELECT
      'ChannelVariant', child."id", 'ContentAsset', parent."id",
      child."clientId", child."brandId", child."siteId", child."siteMarketId",
      parent."clientId", parent."brandId", parent."siteId", parent."siteMarketId"
    FROM "ChannelVariant" child
    JOIN "ContentAsset" parent ON parent."id" = child."contentAssetId"
    UNION ALL
    SELECT
      'GeoFlowTaskLink', child."id", 'ContentAsset', parent."id",
      child."clientId", child."brandId", child."siteId", child."siteMarketId",
      parent."clientId", parent."brandId", parent."siteId", parent."siteMarketId"
    FROM "GeoFlowTaskLink" child
    JOIN "ContentAsset" parent ON parent."id" = child."contentAssetId"
    UNION ALL
    SELECT
      'VariantMetric', child."id", 'ChannelVariant', parent."id",
      child."clientId", child."brandId", child."siteId", child."siteMarketId",
      parent."clientId", parent."brandId", parent."siteId", parent."siteMarketId"
    FROM "VariantMetric" child
    JOIN "ChannelVariant" parent ON parent."id" = child."channelVariantId"
    UNION ALL
    SELECT
      'ExportPackage', child."id", 'ContentAsset', parent."id",
      child."clientId", child."brandId", child."siteId", child."siteMarketId",
      parent."clientId", parent."brandId", parent."siteId", parent."siteMarketId"
    FROM "ExportPackage" child
    JOIN "ContentAsset" parent ON parent."id" = child."contentAssetId"
    UNION ALL
    SELECT
      'DistributionDispatch', child."id", 'ContentAsset', parent."id",
      child."clientId", child."brandId", child."siteId", child."siteMarketId",
      parent."clientId", parent."brandId", parent."siteId", parent."siteMarketId"
    FROM "DistributionDispatch" child
    JOIN "ContentAsset" parent ON parent."id" = child."contentAssetId"
    UNION ALL
    SELECT
      'DistributionDispatch', child."id", 'ExportPackage', parent."id",
      child."clientId", child."brandId", child."siteId", child."siteMarketId",
      parent."clientId", parent."brandId", parent."siteId", parent."siteMarketId"
    FROM "DistributionDispatch" child
    JOIN "ExportPackage" parent ON parent."id" = child."exportPackageId"
  )
  SELECT child_table, child_id, parent_table, parent_id
  INTO mismatch
  FROM relationship_pairs
  WHERE ROW(child_client_id, child_brand_id, child_site_id)
      IS DISTINCT FROM
        ROW(parent_client_id, parent_brand_id, parent_site_id)
     OR (
       child_market_id IS NOT NULL
       AND parent_market_id IS NOT NULL
       AND child_market_id IS DISTINCT FROM parent_market_id
     )
  ORDER BY child_table, child_id, parent_table
  LIMIT 1;

  IF mismatch.child_id IS NOT NULL THEN
    RAISE EXCEPTION
      'legacy relationship ownership mismatch: % row % against % row %',
      mismatch.child_table,
      mismatch.child_id,
      mismatch.parent_table,
      mismatch.parent_id;
  END IF;
END
$$;

-- AuditEvent and EventDelivery use intentional polymorphic references. Known
-- legacy entity types with an entityId are strict provenance links. Unknown
-- types are site-level provenance and therefore cannot carry a market.
-- AuditEvent intentionally permits a known type with entityId NULL as a
-- type-level audit; that is not a dangling reference and must also be
-- site-level. EventDelivery.entityId is NOT NULL in the legacy schema.
DO $$
DECLARE
  reference_row record;
  parent_table text;
  parent_client_id text;
  parent_brand_id text;
  parent_site_id text;
  parent_market_id text;
  matched_rows bigint;
BEGIN
  FOR reference_row IN
    SELECT
      'AuditEvent'::text AS child_table,
      "id" AS child_id,
      "entityType" AS entity_type,
      "entityId" AS entity_id,
      "clientId" AS child_client_id,
      "brandId" AS child_brand_id,
      "siteId" AS child_site_id,
      "siteMarketId" AS child_market_id
    FROM "AuditEvent"
    UNION ALL
    SELECT
      'EventDelivery', "id", "entityType", "entityId",
      "clientId", "brandId", "siteId", "siteMarketId"
    FROM "EventDelivery"
  LOOP
    parent_table := "resolve_legacy_entity_table"(reference_row.entity_type);

    IF parent_table IS NULL THEN
      IF reference_row.child_market_id IS NOT NULL THEN
        RAISE EXCEPTION
          'site-level polymorphic provenance has market: % row % entity type %',
          reference_row.child_table,
          reference_row.child_id,
          reference_row.entity_type;
      END IF;
      CONTINUE;
    END IF;

    IF reference_row.entity_id IS NULL THEN
      IF reference_row.child_market_id IS NOT NULL THEN
        RAISE EXCEPTION
          'type-level polymorphic audit has market: % row % entity type %',
          reference_row.child_table,
          reference_row.child_id,
          reference_row.entity_type;
      END IF;
      CONTINUE;
    END IF;

    EXECUTE format(
      'SELECT "clientId", "brandId", "siteId", "siteMarketId"
       FROM %I
       WHERE "id" = $1
       FOR SHARE',
      parent_table
    )
    INTO
      parent_client_id,
      parent_brand_id,
      parent_site_id,
      parent_market_id
    USING reference_row.entity_id;
    GET DIAGNOSTICS matched_rows = ROW_COUNT;

    IF matched_rows = 0 THEN
      RAISE EXCEPTION
        'legacy polymorphic parent missing: % row % references % row %',
        reference_row.child_table,
        reference_row.child_id,
        parent_table,
        reference_row.entity_id;
    END IF;

    IF ROW(
      reference_row.child_client_id,
      reference_row.child_brand_id,
      reference_row.child_site_id
    ) IS DISTINCT FROM ROW(
      parent_client_id,
      parent_brand_id,
      parent_site_id
    ) OR reference_row.child_market_id IS DISTINCT FROM parent_market_id THEN
      RAISE EXCEPTION
        'legacy relationship ownership mismatch: % row % against % row %',
        reference_row.child_table,
        reference_row.child_id,
        parent_table,
        reference_row.entity_id;
    END IF;
  END LOOP;
END
$$;

-- Keep the backfill/enforce transaction boundary closed. The enforce
-- migration removes these gates only after all permanent constraints and
-- triggers have been installed successfully.
CREATE FUNCTION "block_legacy_writes_until_enforced"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format(
      'ownership migration write gate active for %s',
      TG_TABLE_NAME
    );
END
$$;

DO $$
DECLARE
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
      'CREATE TRIGGER %I
       BEFORE INSERT OR UPDATE OR DELETE ON %I
       FOR EACH STATEMENT
       EXECUTE FUNCTION "block_legacy_writes_until_enforced"()',
      'ownership_backfill_write_gate_' || table_name,
      table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I
       BEFORE TRUNCATE ON %I
       FOR EACH STATEMENT
       EXECUTE FUNCTION "block_legacy_writes_until_enforced"()',
      'ownership_backfill_truncate_gate_' || table_name,
      table_name
    );
  END LOOP;
END
$$;

COMMIT;
