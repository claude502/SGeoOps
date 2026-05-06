# GEO + SEO + Trend Engine Review

Last updated: 2026-05-06

## Summary

This review covers the recently added GEO + SEO dual scoring, trend topic models, content packaging APIs, and `geo-worker` scaffold.

Current conclusion:

- No new blocker-level defects were found after the latest fixes.
- The end-to-end functional path is working locally.
- There are still a few operational follow-ups worth tracking before treating the worker/distribution path as production-complete.

## Scope Reviewed

Reviewed areas:

- Prisma schema extensions for `TrendTopic`, `VariantMetric`, `SeoAudit`, `KeywordRanking`
- SEO dual optimizer
- Viral template library
- Trend leverage prompt builder
- Content packaging and trend management APIs
- `geo-worker` Trigger.dev scaffold
- Local Docker Compose additions

Key files reviewed:

- `prisma/schema.prisma`
- `src/lib/seo/dual-optimizer.ts`
- `src/lib/viral/templates.ts`
- `src/lib/viral/trend-leverage.ts`
- `src/app/api/content/packages/*`
- `src/app/api/content/variants/[id]/metrics/route.ts`
- `src/app/api/trends/*`
- `src/app/api/geo/variant/route.ts`
- `src/lib/prisma.ts`
- `geo-worker/*`
- `docker-compose.yml`

## Functional Test Results

### Static validation

Executed successfully:

- `npm test`
- `npm run typecheck`
- `npm run build`
- `docker compose config`

Result:

- `10` test files passed
- `48` tests passed
- TypeScript check passed
- Next.js production build passed
- Docker Compose config expanded successfully

### Runtime smoke test

A temporary PostgreSQL container and a local `next start` instance were used for functional validation.

Validated successfully:

- `GET /` without auth returns `401`
- `GET /guides` returns `200`
- `GET /api/healthz` returns `200`
- Write APIs without `x-geo-ops-action: true` return `403`
- `POST /api/trends/manual` creates a topic
- `PATCH /api/trends/[id]/status` works
- Invalid trend topic id returns `404`
- `POST /api/content-assets` creates an asset
- `POST /api/geo/brief` returns a brief
- `POST /api/geo/audit` returns runs and persists them
- `POST /api/geo/variant` generates variants
- `POST /api/content/variants/[id]/metrics` writes metrics
- `GET /api/content/packages` returns package list
- `GET /api/content/packages/[id]` returns `seoScore` and linked trend topic data

### Browser verification

Verified in the in-app browser:

- Basic Auth protected dashboard loads successfully after authentication
- Public `guides` page loads anonymously
- Dashboard asset view can see assets created during smoke testing

## Issues Fixed During Review

The following defects were found and fixed during review:

1. `src/lib/prisma.ts`
   The lazy `db` proxy could expose unstable method binding behavior. It now binds Prisma methods to the real client instance.

2. `src/app/api/content/packages/route.ts`
   Invalid `limit` values such as `?limit=abc` could flow into Prisma and fail at runtime. The route now clamps and defaults the value safely.

3. `src/app/api/trends/[id]/status/route.ts`
   Updating a nonexistent topic previously relied on Prisma throwing, which surfaced as a server error. It now returns a stable `404`.

4. `geo-worker`
   The worker image originally lacked a Prisma client generation path. The worker Dockerfile and local Prisma schema were added so the container can initialize Prisma correctly.

5. `src/app/api/geo/variant/route.ts`
   Variant generation originally accepted only `contentAssetId`, while the newly added packaging flow and smoke tests used `assetId`. The route now accepts both field names.

## Residual Risks

These are not blockers for local validation, but they should be treated as follow-up items:

- `geo-worker/src/jobs/trend-crawl.ts`
  Current crawling inserts topics every run with no deduplication window. In production this may create noisy duplicates unless we add a uniqueness or merge strategy.

- `docker-compose.yml`
  The new root compose file is suitable for local/dev usage, but it exposes PostgreSQL on `5432`. That is fine for local development and should not be reused as a public production deployment shape.

- External distribution handoff
  The system now acts correctly as a source-link/content-package producer, but downstream distribution auth, callback contracts, and replay/idempotency rules are not yet productized.

## Recommended Next Steps

1. Add a deduplication policy for `TrendTopic` ingestion.
2. Add API tests for:
   - `assetId` vs `contentAssetId` compatibility
   - package list pagination and bad `limit` handling
   - trend topic `404` behavior
3. Define the first version of `ExportPackage` and downstream callback contract.
4. Split local/dev compose guidance from production deployment guidance more explicitly in docs.
