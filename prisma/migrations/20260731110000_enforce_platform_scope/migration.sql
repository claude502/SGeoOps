BEGIN;

-- Assert each legacy table immediately before enforcing its root ownership.
-- siteMarketId remains nullable for intentional site-level operations.
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
    -- Task 9 contracts ownership by requiring every writer to supply the
    -- complete tuple. The fixed Txpuro rows remain backfilled data only.
    EXECUTE format(
      'SELECT "id" FROM %I
       WHERE "clientId" IS NULL OR "brandId" IS NULL OR "siteId" IS NULL
       ORDER BY "id" LIMIT 1',
      table_name
    ) INTO orphan_id;

    IF orphan_id IS NOT NULL THEN
      RAISE EXCEPTION
        'cannot enforce ownership on %: row % has a NULL root owner',
        table_name,
        orphan_id;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I
         ALTER COLUMN "clientId" SET NOT NULL,
         ALTER COLUMN "brandId" SET NOT NULL,
         ALTER COLUMN "siteId" SET NOT NULL,
         ALTER COLUMN "clientId" DROP DEFAULT,
         ALTER COLUMN "brandId" DROP DEFAULT,
         ALTER COLUMN "siteId" DROP DEFAULT',
      table_name
    );
    orphan_id := NULL;
  END LOOP;
END
$$;

-- Trend keys are tenant data. The pre-platform global key would make one
-- client able to conflict with another client's otherwise-valid topic.
ALTER TABLE "TrendTopic"
  DROP CONSTRAINT IF EXISTS "TrendTopic_keyword_platform_key";
CREATE UNIQUE INDEX "TrendTopic_clientId_keyword_platform_key"
  ON "TrendTopic"("clientId", "keyword", "platform");

-- Individual FKs protect row lifecycle. Restrict is deliberate: deleting a
-- platform root must never silently delete or detach legacy business data.
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
      'ALTER TABLE %I
         ADD CONSTRAINT %I
         FOREIGN KEY ("clientId") REFERENCES "Client"("id")
         ON DELETE RESTRICT ON UPDATE CASCADE',
      table_name,
      table_name || '_clientId_fkey'
    );
    EXECUTE format(
      'ALTER TABLE %I
         ADD CONSTRAINT %I
         FOREIGN KEY ("brandId") REFERENCES "Brand"("id")
         ON DELETE RESTRICT ON UPDATE CASCADE',
      table_name,
      table_name || '_brandId_fkey'
    );
    EXECUTE format(
      'ALTER TABLE %I
         ADD CONSTRAINT %I
         FOREIGN KEY ("siteId") REFERENCES "Site"("id")
         ON DELETE RESTRICT ON UPDATE CASCADE',
      table_name,
      table_name || '_siteId_fkey'
    );
    EXECUTE format(
      'ALTER TABLE %I
         ADD CONSTRAINT %I
         FOREIGN KEY ("siteMarketId") REFERENCES "SiteMarket"("id")
         ON DELETE RESTRICT ON UPDATE CASCADE',
      table_name,
      table_name || '_siteMarketId_fkey'
    );
  END LOOP;
END
$$;

-- clientId/siteId supports the common scoped read. Standalone brand, site,
-- and market indexes cover reverse FK checks whose column is not leftmost.
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
      'CREATE INDEX %I ON %I ("clientId", "siteId")',
      table_name || '_clientId_siteId_idx',
      table_name
    );
    EXECUTE format(
      'CREATE INDEX %I ON %I ("brandId")',
      table_name || '_brandId_idx',
      table_name
    );
    EXECUTE format(
      'CREATE INDEX %I ON %I ("siteId")',
      table_name || '_siteId_idx',
      table_name
    );
    EXECUTE format(
      'CREATE INDEX %I ON %I ("siteMarketId")',
      table_name || '_siteMarketId_idx',
      table_name
    );
  END LOOP;
END
$$;

-- Reverse FK/performance indexes omitted by the expand migration.
CREATE INDEX "Competitor_siteMarketId_idx"
  ON "Competitor"("siteMarketId");
CREATE INDEX "Integration_siteMarketId_idx"
  ON "Integration"("siteMarketId");
CREATE INDEX "AnalysisRun_brandId_idx"
  ON "AnalysisRun"("brandId");
CREATE INDEX "AnalysisRun_siteMarketId_idx"
  ON "AnalysisRun"("siteMarketId");
CREATE INDEX "Recommendation_runId_idx"
  ON "Recommendation"("runId");
CREATE INDEX "Recommendation_siteId_idx"
  ON "Recommendation"("siteId");
CREATE INDEX "RecommendationEvidence_observationId_idx"
  ON "RecommendationEvidence"("observationId");
CREATE INDEX "Opportunity_siteId_idx"
  ON "Opportunity"("siteId");
CREATE INDEX "OpportunityRecommendation_recommendationId_idx"
  ON "OpportunityRecommendation"("recommendationId");
CREATE INDEX "AuditEvent_entityId_idx"
  ON "AuditEvent"("entityId");
CREATE INDEX "EventDelivery_entityId_idx"
  ON "EventDelivery"("entityId");

-- Prisma cannot express partial indexes. Keep the nullable compound uniques
-- from the expand migration and close their NULL-scope uniqueness gap here.
CREATE UNIQUE INDEX "Competitor_brandId_name_null_market_key"
  ON "Competitor"("brandId", "name")
  WHERE "siteMarketId" IS NULL;
CREATE UNIQUE INDEX "Integration_siteId_type_null_market_key"
  ON "Integration"("siteId", "type")
  WHERE "siteMarketId" IS NULL;

-- The ownership helpers lock every parent row whose relationship is read.
-- FOR SHARE conflicts with reparenting/deletion while allowing concurrent
-- readers. Together with the FKs and the parent-reassignment guard below,
-- the check remains true through statement/transaction completion.
CREATE FUNCTION "assert_platform_scope"(
  scope_client_id text,
  scope_brand_id text,
  scope_site_id text,
  scope_market_id text,
  scope_context text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  IF scope_market_id IS NULL THEN
    PERFORM 1
    FROM "Client" client_row
    JOIN "Brand" brand_row
      ON brand_row."clientId" = client_row."id"
    JOIN "Site" site_row
      ON site_row."brandId" = brand_row."id"
    WHERE client_row."id" = scope_client_id
      AND brand_row."id" = scope_brand_id
      AND site_row."id" = scope_site_id
    FOR SHARE OF client_row, brand_row, site_row;
  ELSE
    PERFORM 1
    FROM "Client" client_row
    JOIN "Brand" brand_row
      ON brand_row."clientId" = client_row."id"
    JOIN "Site" site_row
      ON site_row."brandId" = brand_row."id"
    JOIN "SiteMarket" market_row
      ON market_row."siteId" = site_row."id"
    WHERE client_row."id" = scope_client_id
      AND brand_row."id" = scope_brand_id
      AND site_row."id" = scope_site_id
      AND market_row."id" = scope_market_id
    FOR SHARE OF client_row, brand_row, site_row, market_row;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'tenant ownership mismatch for %s: client=%s brand=%s site=%s market=%s',
        scope_context,
        scope_client_id,
        scope_brand_id,
        scope_site_id,
        coalesce(scope_market_id, '<site-level>')
      );
  END IF;
END
$$;

CREATE FUNCTION "assert_brand_market_scope"(
  scope_brand_id text,
  scope_market_id text,
  scope_context text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  IF scope_market_id IS NULL THEN
    PERFORM 1
    FROM "Brand" brand_row
    WHERE brand_row."id" = scope_brand_id
    FOR SHARE OF brand_row;
  ELSE
    PERFORM 1
    FROM "Brand" brand_row
    JOIN "Site" site_row
      ON site_row."brandId" = brand_row."id"
    JOIN "SiteMarket" market_row
      ON market_row."siteId" = site_row."id"
    WHERE brand_row."id" = scope_brand_id
      AND market_row."id" = scope_market_id
    FOR SHARE OF brand_row, site_row, market_row;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'market does not belong to brand for %s: brand=%s market=%s',
        scope_context,
        scope_brand_id,
        coalesce(scope_market_id, '<site-level>')
      );
  END IF;
END
$$;

CREATE FUNCTION "assert_site_market_scope"(
  scope_site_id text,
  scope_market_id text,
  scope_context text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  IF scope_market_id IS NULL THEN
    PERFORM 1
    FROM "Site" site_row
    WHERE site_row."id" = scope_site_id
    FOR SHARE OF site_row;
  ELSE
    PERFORM 1
    FROM "Site" site_row
    JOIN "SiteMarket" market_row
      ON market_row."siteId" = site_row."id"
    WHERE site_row."id" = scope_site_id
      AND market_row."id" = scope_market_id
    FOR SHARE OF site_row, market_row;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'market does not belong to site for %s: site=%s market=%s',
        scope_context,
        scope_site_id,
        coalesce(scope_market_id, '<site-level>')
      );
  END IF;
END
$$;

CREATE FUNCTION "assert_recommendation_scope"(
  scope_run_id text,
  scope_client_id text,
  scope_site_id text,
  scope_context text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM 1
  FROM "AnalysisRun" run_row
  WHERE run_row."id" = scope_run_id
    AND run_row."clientId" = scope_client_id
    AND run_row."siteId" = scope_site_id
  FOR SHARE OF run_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'run ownership mismatch for %s: run=%s client=%s site=%s',
        scope_context,
        scope_run_id,
        scope_client_id,
        scope_site_id
      );
  END IF;
END
$$;

CREATE FUNCTION "assert_opportunity_scope"(
  scope_client_id text,
  scope_site_id text,
  scope_context text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM 1
  FROM "Client" client_row
  JOIN "Brand" brand_row
    ON brand_row."clientId" = client_row."id"
  JOIN "Site" site_row
    ON site_row."brandId" = brand_row."id"
  WHERE client_row."id" = scope_client_id
    AND site_row."id" = scope_site_id
  FOR SHARE OF client_row, brand_row, site_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'site does not belong to client for %s: client=%s site=%s',
        scope_context,
        scope_client_id,
        scope_site_id
      );
  END IF;
END
$$;

CREATE FUNCTION "assert_recommendation_evidence_scope"(
  scope_recommendation_id text,
  scope_observation_id text,
  scope_context text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM 1
  FROM "Recommendation" recommendation_row
  JOIN "Observation" observation_row
    ON observation_row."id" = scope_observation_id
  JOIN "AnalysisRun" run_row
    ON run_row."id" = observation_row."runId"
  WHERE recommendation_row."id" = scope_recommendation_id
    AND recommendation_row."clientId" = run_row."clientId"
    AND recommendation_row."siteId" = run_row."siteId"
  FOR SHARE OF recommendation_row, observation_row, run_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'observation ownership mismatch for %s: recommendation=%s observation=%s',
        scope_context,
        scope_recommendation_id,
        scope_observation_id
      );
  END IF;
END
$$;

CREATE FUNCTION "assert_opportunity_recommendation_scope"(
  scope_opportunity_id text,
  scope_recommendation_id text,
  scope_context text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM 1
  FROM "Opportunity" opportunity_row
  JOIN "Recommendation" recommendation_row
    ON recommendation_row."id" = scope_recommendation_id
  WHERE opportunity_row."id" = scope_opportunity_id
    AND opportunity_row."clientId" = recommendation_row."clientId"
    AND opportunity_row."siteId" = recommendation_row."siteId"
  FOR SHARE OF opportunity_row, recommendation_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'endpoint ownership mismatch for %s: opportunity=%s recommendation=%s',
        scope_context,
        scope_opportunity_id,
        scope_recommendation_id
      );
  END IF;
END
$$;

CREATE FUNCTION "assert_legacy_reference_scope"(
  scope_client_id text,
  scope_brand_id text,
  scope_site_id text,
  scope_market_id text,
  parent_table text,
  parent_id text,
  scope_context text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
DECLARE
  parent_client_id text;
  parent_brand_id text;
  parent_site_id text;
  parent_market_id text;
  matched_rows bigint;
BEGIN
  IF parent_id IS NULL THEN
    RETURN;
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
  USING parent_id;
  GET DIAGNOSTICS matched_rows = ROW_COUNT;

  -- The ordinary FK reports a missing parent. This helper is responsible for
  -- the cross-tenant relationship once the parent exists.
  IF matched_rows = 0 THEN
    RETURN;
  END IF;

  IF ROW(scope_client_id, scope_brand_id, scope_site_id)
      IS DISTINCT FROM
     ROW(parent_client_id, parent_brand_id, parent_site_id)
    OR (
      scope_market_id IS NOT NULL
      AND parent_market_id IS NOT NULL
      AND scope_market_id IS DISTINCT FROM parent_market_id
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'referenced ownership mismatch for %s against %s row %s',
        scope_context,
        parent_table,
        parent_id
      );
  END IF;
END
$$;

-- The immediately preceding backfill migration installs the canonical alias
-- resolver and retains it across the write-gated handoff. Enforce must not
-- carry a second mapping that can drift.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    WHERE namespace.nspname = current_schema()
      AND function.proname = 'resolve_legacy_entity_table'
      AND pg_get_function_identity_arguments(function.oid) = 'entity_type text'
  ) THEN
    RAISE EXCEPTION
      'ownership enforce requires resolve_legacy_entity_table(text) from backfill';
  END IF;
END
$$;

CREATE FUNCTION "assert_polymorphic_reference_scope"(
  scope_client_id text,
  scope_brand_id text,
  scope_site_id text,
  scope_market_id text,
  entity_type text,
  entity_id text,
  scope_context text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
DECLARE
  parent_table text;
  parent_client_id text;
  parent_brand_id text;
  parent_site_id text;
  parent_market_id text;
  matched_rows bigint;
BEGIN
  parent_table := "resolve_legacy_entity_table"(entity_type);
  -- Unknown types are intentional site-level provenance, not unverifiable
  -- market-scoped references.
  IF parent_table IS NULL THEN
    IF scope_market_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'site-level polymorphic provenance requires NULL market for %s: unknown entity type %s',
          scope_context,
          entity_type
        );
    END IF;
    RETURN;
  END IF;

  -- AuditEvent.entityId is intentionally nullable: a known type with no id is
  -- a valid type-level/site-level audit, not a dangling parent reference.
  -- EventDelivery.entityId remains NOT NULL and cannot reach this branch.
  IF entity_id IS NULL THEN
    IF scope_market_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'type-level polymorphic audit requires NULL market for %s: entity type %s',
          scope_context,
          entity_type
        );
    END IF;
    RETURN;
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
  USING entity_id;
  GET DIAGNOSTICS matched_rows = ROW_COUNT;

  IF matched_rows = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'polymorphic parent missing for %s: %s row %s',
        scope_context,
        parent_table,
        entity_id
      );
  END IF;

  IF ROW(scope_client_id, scope_brand_id, scope_site_id)
      IS DISTINCT FROM
     ROW(parent_client_id, parent_brand_id, parent_site_id)
    OR scope_market_id IS DISTINCT FROM parent_market_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'polymorphic ownership mismatch for %s against %s row %s',
        scope_context,
        parent_table,
        entity_id
      );
  END IF;
END
$$;

-- Validate all pre-existing rows before triggers begin protecting new writes.
DO $$
DECLARE
  owned_row record;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ContentAsset', 'GeoRun', 'ChannelVariant', 'GeoFlowTaskLink',
    'GeoFlowSyncRun', 'AuditEvent', 'TrendTopic', 'VariantMetric',
    'SeoAudit', 'KeywordRanking', 'ExportPackage',
    'DistributionDispatch', 'EventDelivery', 'AnalysisRun'
  ]
  LOOP
    FOR owned_row IN EXECUTE format(
      'SELECT "id", "clientId", "brandId", "siteId", "siteMarketId" FROM %I',
      table_name
    )
    LOOP
      PERFORM "assert_platform_scope"(
        owned_row."clientId",
        owned_row."brandId",
        owned_row."siteId",
        owned_row."siteMarketId",
        table_name || ' row ' || owned_row."id"
      );
    END LOOP;
  END LOOP;

  FOR owned_row IN
    SELECT "id", "brandId", "siteMarketId" FROM "Competitor"
  LOOP
    PERFORM "assert_brand_market_scope"(
      owned_row."brandId",
      owned_row."siteMarketId",
      'Competitor row ' || owned_row."id"
    );
  END LOOP;

  FOR owned_row IN
    SELECT "id", "siteId", "siteMarketId" FROM "Integration"
  LOOP
    PERFORM "assert_site_market_scope"(
      owned_row."siteId",
      owned_row."siteMarketId",
      'Integration row ' || owned_row."id"
    );
  END LOOP;

  FOR owned_row IN
    SELECT "id", "runId", "clientId", "siteId" FROM "Recommendation"
  LOOP
    PERFORM "assert_recommendation_scope"(
      owned_row."runId",
      owned_row."clientId",
      owned_row."siteId",
      'Recommendation row ' || owned_row."id"
    );
  END LOOP;

  FOR owned_row IN
    SELECT "id", "clientId", "siteId" FROM "Opportunity"
  LOOP
    PERFORM "assert_opportunity_scope"(
      owned_row."clientId",
      owned_row."siteId",
      'Opportunity row ' || owned_row."id"
    );
  END LOOP;

  FOR owned_row IN
    SELECT "recommendationId", "observationId"
    FROM "RecommendationEvidence"
  LOOP
    PERFORM "assert_recommendation_evidence_scope"(
      owned_row."recommendationId",
      owned_row."observationId",
      'RecommendationEvidence'
    );
  END LOOP;

  FOR owned_row IN
    SELECT "opportunityId", "recommendationId"
    FROM "OpportunityRecommendation"
  LOOP
    PERFORM "assert_opportunity_recommendation_scope"(
      owned_row."opportunityId",
      owned_row."recommendationId",
      'OpportunityRecommendation'
    );
  END LOOP;

  FOR owned_row IN
    SELECT "id", "clientId", "brandId", "siteId", "siteMarketId", "trendTopicId"
    FROM "ContentAsset"
    WHERE "trendTopicId" IS NOT NULL
  LOOP
    PERFORM "assert_legacy_reference_scope"(
      owned_row."clientId",
      owned_row."brandId",
      owned_row."siteId",
      owned_row."siteMarketId",
      'TrendTopic',
      owned_row."trendTopicId",
      'ContentAsset row ' || owned_row."id"
    );
  END LOOP;

  FOR owned_row IN
    SELECT "id", "clientId", "brandId", "siteId", "siteMarketId", "contentAssetId"
    FROM "GeoRun"
    WHERE "contentAssetId" IS NOT NULL
  LOOP
    PERFORM "assert_legacy_reference_scope"(
      owned_row."clientId",
      owned_row."brandId",
      owned_row."siteId",
      owned_row."siteMarketId",
      'ContentAsset',
      owned_row."contentAssetId",
      'GeoRun row ' || owned_row."id"
    );
  END LOOP;

  FOR owned_row IN
    SELECT "id", "clientId", "brandId", "siteId", "siteMarketId", "contentAssetId"
    FROM "ChannelVariant"
  LOOP
    PERFORM "assert_legacy_reference_scope"(
      owned_row."clientId",
      owned_row."brandId",
      owned_row."siteId",
      owned_row."siteMarketId",
      'ContentAsset',
      owned_row."contentAssetId",
      'ChannelVariant row ' || owned_row."id"
    );
  END LOOP;

  FOR owned_row IN
    SELECT "id", "clientId", "brandId", "siteId", "siteMarketId", "contentAssetId"
    FROM "GeoFlowTaskLink"
  LOOP
    PERFORM "assert_legacy_reference_scope"(
      owned_row."clientId",
      owned_row."brandId",
      owned_row."siteId",
      owned_row."siteMarketId",
      'ContentAsset',
      owned_row."contentAssetId",
      'GeoFlowTaskLink row ' || owned_row."id"
    );
  END LOOP;

  FOR owned_row IN
    SELECT "id", "clientId", "brandId", "siteId", "siteMarketId", "channelVariantId"
    FROM "VariantMetric"
  LOOP
    PERFORM "assert_legacy_reference_scope"(
      owned_row."clientId",
      owned_row."brandId",
      owned_row."siteId",
      owned_row."siteMarketId",
      'ChannelVariant',
      owned_row."channelVariantId",
      'VariantMetric row ' || owned_row."id"
    );
  END LOOP;

  FOR owned_row IN
    SELECT "id", "clientId", "brandId", "siteId", "siteMarketId", "contentAssetId"
    FROM "ExportPackage"
  LOOP
    PERFORM "assert_legacy_reference_scope"(
      owned_row."clientId",
      owned_row."brandId",
      owned_row."siteId",
      owned_row."siteMarketId",
      'ContentAsset',
      owned_row."contentAssetId",
      'ExportPackage row ' || owned_row."id"
    );
  END LOOP;

  FOR owned_row IN
    SELECT
      "id", "clientId", "brandId", "siteId", "siteMarketId",
      "contentAssetId", "exportPackageId"
    FROM "DistributionDispatch"
  LOOP
    PERFORM "assert_legacy_reference_scope"(
      owned_row."clientId",
      owned_row."brandId",
      owned_row."siteId",
      owned_row."siteMarketId",
      'ContentAsset',
      owned_row."contentAssetId",
      'DistributionDispatch row ' || owned_row."id"
    );
    PERFORM "assert_legacy_reference_scope"(
      owned_row."clientId",
      owned_row."brandId",
      owned_row."siteId",
      owned_row."siteMarketId",
      'ExportPackage',
      owned_row."exportPackageId",
      'DistributionDispatch row ' || owned_row."id"
    );
  END LOOP;

  FOR owned_row IN
    SELECT
      "id", "clientId", "brandId", "siteId", "siteMarketId",
      "entityType", "entityId"
    FROM "AuditEvent"
  LOOP
    PERFORM "assert_polymorphic_reference_scope"(
      owned_row."clientId",
      owned_row."brandId",
      owned_row."siteId",
      owned_row."siteMarketId",
      owned_row."entityType",
      owned_row."entityId",
      'AuditEvent row ' || owned_row."id"
    );
  END LOOP;

  FOR owned_row IN
    SELECT
      "id", "clientId", "brandId", "siteId", "siteMarketId",
      "entityType", "entityId"
    FROM "EventDelivery"
  LOOP
    PERFORM "assert_polymorphic_reference_scope"(
      owned_row."clientId",
      owned_row."brandId",
      owned_row."siteId",
      owned_row."siteMarketId",
      owned_row."entityType",
      owned_row."entityId",
      'EventDelivery row ' || owned_row."id"
    );
  END LOOP;
END
$$;

CREATE FUNCTION "enforce_owned_row_scope"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM "assert_platform_scope"(
    NEW."clientId",
    NEW."brandId",
    NEW."siteId",
    NEW."siteMarketId",
    TG_TABLE_NAME || ' row ' || NEW."id"
  );
  RETURN NEW;
END
$$;

CREATE FUNCTION "enforce_legacy_reference_scope"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'ContentAsset' THEN
      PERFORM "assert_legacy_reference_scope"(
        NEW."clientId", NEW."brandId", NEW."siteId", NEW."siteMarketId",
        'TrendTopic', NEW."trendTopicId",
        'ContentAsset row ' || NEW."id"
      );
    WHEN 'GeoRun' THEN
      PERFORM "assert_legacy_reference_scope"(
        NEW."clientId", NEW."brandId", NEW."siteId", NEW."siteMarketId",
        'ContentAsset', NEW."contentAssetId",
        'GeoRun row ' || NEW."id"
      );
    WHEN 'ChannelVariant' THEN
      PERFORM "assert_legacy_reference_scope"(
        NEW."clientId", NEW."brandId", NEW."siteId", NEW."siteMarketId",
        'ContentAsset', NEW."contentAssetId",
        'ChannelVariant row ' || NEW."id"
      );
    WHEN 'GeoFlowTaskLink' THEN
      PERFORM "assert_legacy_reference_scope"(
        NEW."clientId", NEW."brandId", NEW."siteId", NEW."siteMarketId",
        'ContentAsset', NEW."contentAssetId",
        'GeoFlowTaskLink row ' || NEW."id"
      );
    WHEN 'VariantMetric' THEN
      PERFORM "assert_legacy_reference_scope"(
        NEW."clientId", NEW."brandId", NEW."siteId", NEW."siteMarketId",
        'ChannelVariant', NEW."channelVariantId",
        'VariantMetric row ' || NEW."id"
      );
    WHEN 'ExportPackage' THEN
      PERFORM "assert_legacy_reference_scope"(
        NEW."clientId", NEW."brandId", NEW."siteId", NEW."siteMarketId",
        'ContentAsset', NEW."contentAssetId",
        'ExportPackage row ' || NEW."id"
      );
    WHEN 'DistributionDispatch' THEN
      PERFORM "assert_legacy_reference_scope"(
        NEW."clientId", NEW."brandId", NEW."siteId", NEW."siteMarketId",
        'ContentAsset', NEW."contentAssetId",
        'DistributionDispatch row ' || NEW."id"
      );
      PERFORM "assert_legacy_reference_scope"(
        NEW."clientId", NEW."brandId", NEW."siteId", NEW."siteMarketId",
        'ExportPackage', NEW."exportPackageId",
        'DistributionDispatch row ' || NEW."id"
      );
  END CASE;
  RETURN NEW;
END
$$;

CREATE FUNCTION "enforce_legacy_reference_dependents"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
DECLARE
  dependent_row record;
BEGIN
  IF TG_TABLE_NAME = 'TrendTopic' THEN
    FOR dependent_row IN
      SELECT "id", "clientId", "brandId", "siteId", "siteMarketId"
      FROM "ContentAsset"
      WHERE "trendTopicId" = NEW."id"
    LOOP
      PERFORM "assert_legacy_reference_scope"(
        dependent_row."clientId",
        dependent_row."brandId",
        dependent_row."siteId",
        dependent_row."siteMarketId",
        'TrendTopic',
        NEW."id",
        'ContentAsset row ' || dependent_row."id"
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'ContentAsset' THEN
    FOR dependent_row IN
      SELECT 'GeoRun' AS child_table, "id", "clientId", "brandId", "siteId", "siteMarketId"
      FROM "GeoRun" WHERE "contentAssetId" = NEW."id"
      UNION ALL
      SELECT 'ChannelVariant', "id", "clientId", "brandId", "siteId", "siteMarketId"
      FROM "ChannelVariant" WHERE "contentAssetId" = NEW."id"
      UNION ALL
      SELECT 'GeoFlowTaskLink', "id", "clientId", "brandId", "siteId", "siteMarketId"
      FROM "GeoFlowTaskLink" WHERE "contentAssetId" = NEW."id"
      UNION ALL
      SELECT 'ExportPackage', "id", "clientId", "brandId", "siteId", "siteMarketId"
      FROM "ExportPackage" WHERE "contentAssetId" = NEW."id"
      UNION ALL
      SELECT 'DistributionDispatch', "id", "clientId", "brandId", "siteId", "siteMarketId"
      FROM "DistributionDispatch" WHERE "contentAssetId" = NEW."id"
    LOOP
      PERFORM "assert_legacy_reference_scope"(
        dependent_row."clientId",
        dependent_row."brandId",
        dependent_row."siteId",
        dependent_row."siteMarketId",
        'ContentAsset',
        NEW."id",
        dependent_row.child_table || ' row ' || dependent_row."id"
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'ChannelVariant' THEN
    FOR dependent_row IN
      SELECT "id", "clientId", "brandId", "siteId", "siteMarketId"
      FROM "VariantMetric"
      WHERE "channelVariantId" = NEW."id"
    LOOP
      PERFORM "assert_legacy_reference_scope"(
        dependent_row."clientId",
        dependent_row."brandId",
        dependent_row."siteId",
        dependent_row."siteMarketId",
        'ChannelVariant',
        NEW."id",
        'VariantMetric row ' || dependent_row."id"
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'ExportPackage' THEN
    FOR dependent_row IN
      SELECT "id", "clientId", "brandId", "siteId", "siteMarketId"
      FROM "DistributionDispatch"
      WHERE "exportPackageId" = NEW."id"
    LOOP
      PERFORM "assert_legacy_reference_scope"(
        dependent_row."clientId",
        dependent_row."brandId",
        dependent_row."siteId",
        dependent_row."siteMarketId",
        'ExportPackage',
        NEW."id",
        'DistributionDispatch row ' || dependent_row."id"
      );
    END LOOP;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "enforce_polymorphic_reference_scope"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM "assert_polymorphic_reference_scope"(
    NEW."clientId",
    NEW."brandId",
    NEW."siteId",
    NEW."siteMarketId",
    NEW."entityType",
    NEW."entityId",
    TG_TABLE_NAME || ' row ' || NEW."id"
  );
  RETURN NEW;
END
$$;

CREATE FUNCTION "enforce_polymorphic_reference_dependents"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
DECLARE
  reference_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    FOR reference_row IN
      SELECT "id"
      FROM "AuditEvent"
      WHERE "entityId" = OLD."id"
        AND "resolve_legacy_entity_table"("entityType") = TG_TABLE_NAME
      FOR SHARE
    LOOP
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'polymorphic parent delete restricted for %s row %s by AuditEvent row %s',
          TG_TABLE_NAME,
          OLD."id",
          reference_row."id"
        );
    END LOOP;

    FOR reference_row IN
      SELECT "id"
      FROM "EventDelivery"
      WHERE "entityId" = OLD."id"
        AND "resolve_legacy_entity_table"("entityType") = TG_TABLE_NAME
      FOR SHARE
    LOOP
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'polymorphic parent delete restricted for %s row %s by EventDelivery row %s',
          TG_TABLE_NAME,
          OLD."id",
          reference_row."id"
        );
    END LOOP;
    RETURN OLD;
  END IF;

  IF OLD."id" IS DISTINCT FROM NEW."id" THEN
    FOR reference_row IN
      SELECT "id"
      FROM "AuditEvent"
      WHERE "entityId" = OLD."id"
        AND "resolve_legacy_entity_table"("entityType") = TG_TABLE_NAME
      FOR SHARE
    LOOP
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'polymorphic parent identity update restricted for %s row %s',
          TG_TABLE_NAME,
          OLD."id"
        );
    END LOOP;

    FOR reference_row IN
      SELECT "id"
      FROM "EventDelivery"
      WHERE "entityId" = OLD."id"
        AND "resolve_legacy_entity_table"("entityType") = TG_TABLE_NAME
      FOR SHARE
    LOOP
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'polymorphic parent identity update restricted for %s row %s',
          TG_TABLE_NAME,
          OLD."id"
        );
    END LOOP;
    RETURN NEW;
  END IF;

  FOR reference_row IN
    SELECT
      "id", "clientId", "brandId", "siteId", "siteMarketId",
      "entityType", "entityId"
    FROM "AuditEvent"
    WHERE "entityId" = NEW."id"
      AND "resolve_legacy_entity_table"("entityType") = TG_TABLE_NAME
    FOR SHARE
  LOOP
    PERFORM "assert_polymorphic_reference_scope"(
      reference_row."clientId",
      reference_row."brandId",
      reference_row."siteId",
      reference_row."siteMarketId",
      reference_row."entityType",
      reference_row."entityId",
      'AuditEvent row ' || reference_row."id"
    );
  END LOOP;

  FOR reference_row IN
    SELECT
      "id", "clientId", "brandId", "siteId", "siteMarketId",
      "entityType", "entityId"
    FROM "EventDelivery"
    WHERE "entityId" = NEW."id"
      AND "resolve_legacy_entity_table"("entityType") = TG_TABLE_NAME
    FOR SHARE
  LOOP
    PERFORM "assert_polymorphic_reference_scope"(
      reference_row."clientId",
      reference_row."brandId",
      reference_row."siteId",
      reference_row."siteMarketId",
      reference_row."entityType",
      reference_row."entityId",
      'EventDelivery row ' || reference_row."id"
    );
  END LOOP;
  RETURN NEW;
END
$$;

CREATE FUNCTION "enforce_polymorphic_parent_truncate"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
DECLARE
  reference_row record;
BEGIN
  SELECT child_table, child_id
  INTO reference_row
  FROM (
    SELECT 'AuditEvent'::text AS child_table, "id" AS child_id
    FROM "AuditEvent"
    WHERE "entityId" IS NOT NULL
      AND "resolve_legacy_entity_table"("entityType") = TG_TABLE_NAME
    UNION ALL
    SELECT 'EventDelivery', "id"
    FROM "EventDelivery"
    WHERE "entityId" IS NOT NULL
      AND "resolve_legacy_entity_table"("entityType") = TG_TABLE_NAME
  ) known_reference
  ORDER BY child_table, child_id
  LIMIT 1;

  IF reference_row.child_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'polymorphic parent truncate restricted for %s by %s row %s',
        TG_TABLE_NAME,
        reference_row.child_table,
        reference_row.child_id
      );
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "enforce_competitor_scope"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM "assert_brand_market_scope"(
    NEW."brandId",
    NEW."siteMarketId",
    'Competitor row ' || NEW."id"
  );
  RETURN NEW;
END
$$;

CREATE FUNCTION "enforce_integration_scope"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM "assert_site_market_scope"(
    NEW."siteId",
    NEW."siteMarketId",
    'Integration row ' || NEW."id"
  );
  RETURN NEW;
END
$$;

CREATE FUNCTION "enforce_recommendation_scope"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
DECLARE
  dependent_row record;
BEGIN
  PERFORM "assert_recommendation_scope"(
    NEW."runId",
    NEW."clientId",
    NEW."siteId",
    'Recommendation row ' || NEW."id"
  );

  FOR dependent_row IN
    SELECT "observationId"
    FROM "RecommendationEvidence"
    WHERE "recommendationId" = NEW."id"
  LOOP
    PERFORM "assert_recommendation_evidence_scope"(
      NEW."id",
      dependent_row."observationId",
      'RecommendationEvidence'
    );
  END LOOP;

  FOR dependent_row IN
    SELECT "opportunityId"
    FROM "OpportunityRecommendation"
    WHERE "recommendationId" = NEW."id"
  LOOP
    PERFORM "assert_opportunity_recommendation_scope"(
      dependent_row."opportunityId",
      NEW."id",
      'OpportunityRecommendation'
    );
  END LOOP;
  RETURN NEW;
END
$$;

CREATE FUNCTION "enforce_opportunity_scope"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
DECLARE
  dependent_row record;
BEGIN
  PERFORM "assert_opportunity_scope"(
    NEW."clientId",
    NEW."siteId",
    'Opportunity row ' || NEW."id"
  );

  FOR dependent_row IN
    SELECT "recommendationId"
    FROM "OpportunityRecommendation"
    WHERE "opportunityId" = NEW."id"
  LOOP
    PERFORM "assert_opportunity_recommendation_scope"(
      NEW."id",
      dependent_row."recommendationId",
      'OpportunityRecommendation'
    );
  END LOOP;
  RETURN NEW;
END
$$;

CREATE FUNCTION "enforce_recommendation_evidence_scope"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM "assert_recommendation_evidence_scope"(
    NEW."recommendationId",
    NEW."observationId",
    'RecommendationEvidence'
  );
  RETURN NEW;
END
$$;

CREATE FUNCTION "enforce_opportunity_recommendation_scope"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM "assert_opportunity_recommendation_scope"(
    NEW."opportunityId",
    NEW."recommendationId",
    'OpportunityRecommendation'
  );
  RETURN NEW;
END
$$;

CREATE FUNCTION "enforce_analysis_run_dependents"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
DECLARE
  dependent_row record;
BEGIN
  FOR dependent_row IN
    SELECT "id", "runId", "clientId", "siteId"
    FROM "Recommendation"
    WHERE "runId" = NEW."id"
  LOOP
    PERFORM "assert_recommendation_scope"(
      dependent_row."runId",
      dependent_row."clientId",
      dependent_row."siteId",
      'Recommendation row ' || dependent_row."id"
    );
  END LOOP;

  FOR dependent_row IN
    SELECT evidence."recommendationId", evidence."observationId"
    FROM "Observation" observation_row
    JOIN "RecommendationEvidence" evidence
      ON evidence."observationId" = observation_row."id"
    WHERE observation_row."runId" = NEW."id"
  LOOP
    PERFORM "assert_recommendation_evidence_scope"(
      dependent_row."recommendationId",
      dependent_row."observationId",
      'RecommendationEvidence'
    );
  END LOOP;
  RETURN NEW;
END
$$;

CREATE FUNCTION "enforce_observation_dependents"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
DECLARE
  dependent_row record;
BEGIN
  FOR dependent_row IN
    SELECT "recommendationId", "observationId"
    FROM "RecommendationEvidence"
    WHERE "observationId" = NEW."id"
  LOOP
    PERFORM "assert_recommendation_evidence_scope"(
      dependent_row."recommendationId",
      dependent_row."observationId",
      'RecommendationEvidence'
    );
  END LOOP;
  RETURN NEW;
END
$$;

CREATE FUNCTION "prevent_tenant_parent_reassignment"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = format(
      'tenant parent reassignment is not allowed for %s row %s',
      TG_TABLE_NAME,
      NEW."id"
    );
END
$$;

-- Every owned legacy row and AnalysisRun is checked at statement completion.
-- These constraint triggers are deliberately NOT DEFERRABLE: a write must
-- submit its complete ownership tuple in one statement.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ContentAsset', 'GeoRun', 'ChannelVariant', 'GeoFlowTaskLink',
    'GeoFlowSyncRun', 'AuditEvent', 'TrendTopic', 'VariantMetric',
    'SeoAudit', 'KeywordRanking', 'ExportPackage',
    'DistributionDispatch', 'EventDelivery', 'AnalysisRun'
  ]
  LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I
       AFTER INSERT OR UPDATE OF "clientId", "brandId", "siteId", "siteMarketId"
       ON %I
       NOT DEFERRABLE INITIALLY IMMEDIATE
       FOR EACH ROW
       EXECUTE FUNCTION "enforce_owned_row_scope"()',
      'ownership_scope_' || table_name,
      table_name
    );
  END LOOP;
END
$$;

CREATE CONSTRAINT TRIGGER "ownership_poly_child_AuditEvent"
AFTER INSERT OR UPDATE OF
  "clientId", "brandId", "siteId", "siteMarketId", "entityType", "entityId"
ON "AuditEvent"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_polymorphic_reference_scope"();

CREATE CONSTRAINT TRIGGER "ownership_poly_child_EventDelivery"
AFTER INSERT OR UPDATE OF
  "clientId", "brandId", "siteId", "siteMarketId", "entityType", "entityId"
ON "EventDelivery"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_polymorphic_reference_scope"();

-- Known polymorphic parents have no ordinary FK. Reverse UPDATE checks plus
-- BEFORE DELETE row guards and BEFORE TRUNCATE statement guards provide the
-- lifecycle guarantees while retaining intentional unknown entity types as
-- site-level provenance.
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
      'CREATE CONSTRAINT TRIGGER %I
       AFTER UPDATE OF "id", "clientId", "brandId", "siteId", "siteMarketId"
       ON %I
       NOT DEFERRABLE INITIALLY IMMEDIATE
       FOR EACH ROW
       EXECUTE FUNCTION "enforce_polymorphic_reference_dependents"()',
      'ownership_poly_parent_update_' || table_name,
      table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I
       BEFORE DELETE ON %I
       FOR EACH ROW
       EXECUTE FUNCTION "enforce_polymorphic_reference_dependents"()',
      'ownership_poly_parent_delete_' || table_name,
      table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I
       BEFORE TRUNCATE ON %I
       FOR EACH STATEMENT
       EXECUTE FUNCTION "enforce_polymorphic_parent_truncate"()',
      'ownership_poly_parent_truncate_' || table_name,
      table_name
    );
  END LOOP;
END
$$;

CREATE CONSTRAINT TRIGGER "ownership_zz_relationship_ContentAsset"
AFTER INSERT OR UPDATE OF
  "clientId", "brandId", "siteId", "siteMarketId", "trendTopicId"
ON "ContentAsset"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_legacy_reference_scope"();

CREATE CONSTRAINT TRIGGER "ownership_zz_relationship_GeoRun"
AFTER INSERT OR UPDATE OF
  "clientId", "brandId", "siteId", "siteMarketId", "contentAssetId"
ON "GeoRun"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_legacy_reference_scope"();

CREATE CONSTRAINT TRIGGER "ownership_zz_relationship_ChannelVariant"
AFTER INSERT OR UPDATE OF
  "clientId", "brandId", "siteId", "siteMarketId", "contentAssetId"
ON "ChannelVariant"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_legacy_reference_scope"();

CREATE CONSTRAINT TRIGGER "ownership_zz_relationship_GeoFlowTaskLink"
AFTER INSERT OR UPDATE OF
  "clientId", "brandId", "siteId", "siteMarketId", "contentAssetId"
ON "GeoFlowTaskLink"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_legacy_reference_scope"();

CREATE CONSTRAINT TRIGGER "ownership_zz_relationship_VariantMetric"
AFTER INSERT OR UPDATE OF
  "clientId", "brandId", "siteId", "siteMarketId", "channelVariantId"
ON "VariantMetric"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_legacy_reference_scope"();

CREATE CONSTRAINT TRIGGER "ownership_zz_relationship_ExportPackage"
AFTER INSERT OR UPDATE OF
  "clientId", "brandId", "siteId", "siteMarketId", "contentAssetId"
ON "ExportPackage"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_legacy_reference_scope"();

CREATE CONSTRAINT TRIGGER "ownership_zz_relationship_DistributionDispatch"
AFTER INSERT OR UPDATE OF
  "clientId", "brandId", "siteId", "siteMarketId",
  "contentAssetId", "exportPackageId"
ON "DistributionDispatch"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_legacy_reference_scope"();

CREATE CONSTRAINT TRIGGER "ownership_zzz_dependents_TrendTopic"
AFTER UPDATE OF "clientId", "brandId", "siteId", "siteMarketId"
ON "TrendTopic"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_legacy_reference_dependents"();

CREATE CONSTRAINT TRIGGER "ownership_zzz_dependents_ContentAsset"
AFTER UPDATE OF "clientId", "brandId", "siteId", "siteMarketId"
ON "ContentAsset"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_legacy_reference_dependents"();

CREATE CONSTRAINT TRIGGER "ownership_zzz_dependents_ChannelVariant"
AFTER UPDATE OF "clientId", "brandId", "siteId", "siteMarketId"
ON "ChannelVariant"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_legacy_reference_dependents"();

CREATE CONSTRAINT TRIGGER "ownership_zzz_dependents_ExportPackage"
AFTER UPDATE OF "clientId", "brandId", "siteId", "siteMarketId"
ON "ExportPackage"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_legacy_reference_dependents"();

CREATE CONSTRAINT TRIGGER "ownership_scope_Competitor"
AFTER INSERT OR UPDATE OF "brandId", "siteMarketId"
ON "Competitor"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_competitor_scope"();

CREATE CONSTRAINT TRIGGER "ownership_scope_Integration"
AFTER INSERT OR UPDATE OF "siteId", "siteMarketId"
ON "Integration"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_integration_scope"();

CREATE CONSTRAINT TRIGGER "ownership_scope_Recommendation"
AFTER INSERT OR UPDATE OF "runId", "clientId", "siteId"
ON "Recommendation"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_recommendation_scope"();

CREATE CONSTRAINT TRIGGER "ownership_scope_Opportunity"
AFTER INSERT OR UPDATE OF "clientId", "siteId"
ON "Opportunity"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_opportunity_scope"();

CREATE CONSTRAINT TRIGGER "ownership_scope_RecommendationEvidence"
AFTER INSERT OR UPDATE OF "recommendationId", "observationId"
ON "RecommendationEvidence"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_recommendation_evidence_scope"();

CREATE CONSTRAINT TRIGGER "ownership_scope_OpportunityRecommendation"
AFTER INSERT OR UPDATE OF "opportunityId", "recommendationId"
ON "OpportunityRecommendation"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_opportunity_recommendation_scope"();

CREATE CONSTRAINT TRIGGER "ownership_zz_dependents_AnalysisRun"
AFTER UPDATE OF "clientId", "brandId", "siteId", "siteMarketId"
ON "AnalysisRun"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_analysis_run_dependents"();

CREATE CONSTRAINT TRIGGER "ownership_zz_dependents_Observation"
AFTER UPDATE OF "runId"
ON "Observation"
NOT DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_observation_dependents"();

-- Reparenting a platform ownership node can invalidate many child tuples
-- without touching them. Require an explicit data migration instead.
CREATE TRIGGER "tenant_parent_Client"
BEFORE UPDATE OF "workspaceId"
ON "Client"
FOR EACH ROW
WHEN (OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId")
EXECUTE FUNCTION "prevent_tenant_parent_reassignment"();

CREATE TRIGGER "tenant_parent_Brand"
BEFORE UPDATE OF "clientId"
ON "Brand"
FOR EACH ROW
WHEN (OLD."clientId" IS DISTINCT FROM NEW."clientId")
EXECUTE FUNCTION "prevent_tenant_parent_reassignment"();

CREATE TRIGGER "tenant_parent_Site"
BEFORE UPDATE OF "brandId"
ON "Site"
FOR EACH ROW
WHEN (OLD."brandId" IS DISTINCT FROM NEW."brandId")
EXECUTE FUNCTION "prevent_tenant_parent_reassignment"();

CREATE TRIGGER "tenant_parent_SiteMarket"
BEFORE UPDATE OF "siteId"
ON "SiteMarket"
FOR EACH ROW
WHEN (OLD."siteId" IS DISTINCT FROM NEW."siteId")
EXECUTE FUNCTION "prevent_tenant_parent_reassignment"();

-- This is the final handoff from the temporary migration gate to permanent
-- constraints. If any enforce statement fails, transaction rollback leaves
-- the committed backfill gates in place.
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
      'DROP TRIGGER %I ON %I',
      'ownership_backfill_write_gate_' || table_name,
      table_name
    );
    EXECUTE format(
      'DROP TRIGGER %I ON %I',
      'ownership_backfill_truncate_gate_' || table_name,
      table_name
    );
  END LOOP;
END
$$;

DROP FUNCTION "block_legacy_writes_until_enforced"();

COMMIT;
