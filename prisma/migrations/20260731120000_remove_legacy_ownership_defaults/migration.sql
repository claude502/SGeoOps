-- Ownership is now supplied by scoped repositories. Keep Txpuro ownership as
-- backfilled data, never as an implicit persistence fallback.
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
         ALTER COLUMN "clientId" DROP DEFAULT,
         ALTER COLUMN "brandId" DROP DEFAULT,
         ALTER COLUMN "siteId" DROP DEFAULT',
      table_name
    );
  END LOOP;
END
$$;

-- Trend keys are tenant data. The pre-platform global key would make one
-- client able to conflict with another client's otherwise-valid topic.
DROP INDEX IF EXISTS "TrendTopic_keyword_platform_key";
CREATE UNIQUE INDEX "TrendTopic_clientId_keyword_platform_key"
  ON "TrendTopic"("clientId", "keyword", "platform");
