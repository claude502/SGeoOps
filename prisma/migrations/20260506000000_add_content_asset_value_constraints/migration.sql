-- Add DB-level check constraints for string enum fields on ContentAsset.
-- These enforce the same value sets as the TypeScript union types in src/types/geo.ts,
-- catching invalid data written via seeding scripts or raw DB access (not just the API).

ALTER TABLE "ContentAsset" ADD CONSTRAINT "content_asset_locale_check"
  CHECK (locale IN ('zh-CN', 'en'));

ALTER TABLE "ContentAsset" ADD CONSTRAINT "content_asset_asset_type_check"
  CHECK ("assetType" IN ('money-page', 'feature-page', 'guide-page', 'compare-page', 'faq-page'));

ALTER TABLE "ContentAsset" ADD CONSTRAINT "content_asset_schema_type_check"
  CHECK ("schemaType" IN ('product', 'faq', 'article'));

ALTER TABLE "ContentAsset" ADD CONSTRAINT "content_asset_cta_mode_check"
  CHECK ("ctaMode" IN ('self_signup', 'demo', 'contact'));

ALTER TABLE "ContentAsset" ADD CONSTRAINT "content_asset_publish_target_check"
  CHECK ("publishTarget" IN ('txpuro', 'geo_ops_internal'));
