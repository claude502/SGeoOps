# Phase 2 SEO Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a complete owned-site SEO loop from scheduled scans and external data sync through immutable evidence, metrics, recommendations, opportunities, and scoped reporting.

**Architecture:** Trigger.dev v4 runs SiteOne, Unlighthouse, Search Console, and Matomo adapters. Workers upload artifacts and a versioned `AnalysisEnvelope` to signed SGeoOps endpoints; only SGeoOps writes business data. Pure calculators turn observations into versioned metrics and traceable opportunities.

**Tech Stack:** Trigger.dev v4, SiteOne, Unlighthouse, Chromium, Google Search Console API, Matomo Core, Next.js, Prisma, Zod, Vitest, Docker Compose

---

## Prerequisites

Phase 1 is merged and these exports exist:

```typescript
import type { AnalysisEnvelope, NormalizedObservation } from "@sgeo/analysis-contract";
import type { AccessScope } from "@/lib/authorization";
import type { ArtifactStore } from "@/lib/artifacts/store";
```

Do not extend legacy `SeoAudit` or `KeywordRanking`. Backfill them into common
`AnalysisRun`, `Observation`, and `MetricSnapshot` rows, then keep them
read-only until Phase 5 removes compatibility reads.

## File Structure

Create:

```text
geo-worker/trigger.config.ts
geo-worker/src/clients/sgeo-ops.ts
geo-worker/src/clients/search-console.ts
geo-worker/src/clients/matomo.ts
geo-worker/src/adapters/siteone.ts
geo-worker/src/adapters/unlighthouse.ts
geo-worker/src/adapters/search-console.ts
geo-worker/src/adapters/matomo.ts
geo-worker/src/tasks/siteone-crawl.ts
geo-worker/src/tasks/unlighthouse-audit.ts
geo-worker/src/tasks/search-console-sync.ts
geo-worker/src/tasks/matomo-sync.ts
geo-worker/test/fixtures/{siteone,unlighthouse,search-console,matomo}/{success,partial,invalid,rate-limited,unauthorized,upstream-error}.json
src/lib/analysis/ingest-service.ts
src/lib/analysis/ingest-service.test.ts
src/app/api/internal/analysis-runs/[id]/artifacts/route.ts
src/app/api/internal/analysis-runs/[id]/artifacts/route.test.ts
src/lib/seo/metrics.ts
src/lib/seo/metrics.test.ts
src/lib/seo/opportunity-detectors.ts
src/lib/seo/opportunity-detectors.test.ts
src/lib/seo/report-queries.ts
src/app/api/internal/analysis-runs/ingest/route.ts
src/app/api/internal/analysis-runs/ingest/route.test.ts
src/app/api/sites/[siteId]/analysis-runs/route.ts
src/app/api/sites/[siteId]/opportunities/route.ts
src/app/api/sites/[siteId]/reports/seo/route.ts
src/app/(ops)/sites/[siteId]/seo/page.tsx
src/app/(ops)/sites/[siteId]/opportunities/page.tsx
src/components/seo/baseline-summary.tsx
src/components/seo/comparison-table.tsx
src/components/seo/run-history.tsx
src/components/opportunities/opportunity-queue.tsx
deploy/docker-compose.integration.yml
deploy/trigger/README.md
deploy/trigger.env.example
deploy/backup-matomo.sh
deploy/backup-artifacts.sh
tests/integration/seo-loop.test.ts
```

Modify:

```text
package.json
package-lock.json
geo-worker/package.json
geo-worker/Dockerfile
docker-compose.yml
deploy/docker-compose.prod.example.yml
.env.example
prisma/schema.prisma
```

Delete after v4 parity:

```text
geo-worker/src/trigger.ts
geo-worker/src/index.ts
geo-worker/src/trigger-dev-sdk.d.ts
geo-worker/src/jobs/seo-audit.ts
```

### Task 1: Migrate The Worker To Trigger.dev v4

**Files:**
- Modify: `geo-worker/package.json`
- Create: `geo-worker/trigger.config.ts`
- Create: `geo-worker/src/clients/sgeo-ops.ts`
- Delete: v2 files listed above

- [ ] **Step 1: Add a failing worker contract test**

Create `geo-worker/src/clients/sgeo-ops.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { SgeoOpsClient } from "./sgeo-ops";

it("sends a signed analysis envelope without a database connection", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  const client = new SgeoOpsClient({
    baseUrl: "http://geo-ops:3000",
    secret: "secret",
    fetch,
  });
  await client.ingest({
    contractVersion: "1",
    runId: "run_1",
    clientId: "client_1",
    brandId: "brand_1",
    siteId: "site_1",
    siteMarketId: null,
    source: "siteone",
    sourceVersion: "2.5.1",
    adapterVersion: "1.0.0",
    status: "succeeded",
    startedAt: "2026-07-31T01:00:00.000Z",
    finishedAt: "2026-07-31T01:01:00.000Z",
    rawArtifact: null,
    observations: [],
    error: null,
  });
  expect(fetch).toHaveBeenCalledWith(
    "http://geo-ops:3000/api/internal/analysis-runs/ingest",
    expect.objectContaining({ method: "POST" }),
  );
});
```

Run:

```bash
npm --workspace geo-worker test -- src/clients/sgeo-ops.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Pin v4 and configure task directories**

Use Trigger.dev `4.5.9` for the SDK, build package, CLI, and deployment images:

```json
{
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "trigger:dev": "trigger dev",
    "trigger:deploy:dry": "trigger deploy --dry-run"
  },
  "dependencies": {
    "@sgeo/analysis-contract": "1.0.0",
    "@sgeo/internal-protocol": "1.0.0",
    "@trigger.dev/sdk": "4.5.9"
  },
  "devDependencies": {
    "@trigger.dev/build": "4.5.9",
    "typescript": "6.0.3",
    "vitest": "4.1.5"
  }
}
```

Pin Trigger.dev webapp, supervisor, CLI, SDK, and build packages to `4.5.9`.
Do not use `latest`.

Create `geo-worker/trigger.config.ts`:

```typescript
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_sgeo_ops",
  dirs: ["./src/tasks"],
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 3, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000, factor: 2 },
  },
});
```

- [ ] **Step 3: Implement the signed SGeoOps client**

The client validates with `analysisEnvelopeSchema`, signs the exact serialized
body using `@sgeo/internal-protocol`, sends `x-sgeo-timestamp` and
`x-sgeo-signature`, and classifies `429`, `5xx`, `401`, and `403`. Expose:

```typescript
export class SgeoOpsClient {
  ingest(envelope: AnalysisEnvelope): Promise<void>;
  uploadArtifact(
    runId: string,
    name: string,
    body: Uint8Array,
    mediaType: string,
  ): Promise<NonNullable<AnalysisEnvelope["rawArtifact"]>>;
}
```

`uploadArtifact` sends the bytes to
`/api/internal/analysis-runs/[id]/artifacts` before `ingest` references the
returned URI.

- [ ] **Step 4: Verify and commit**

```bash
npm --workspace geo-worker test
npm --workspace geo-worker run typecheck
npm --workspace geo-worker run trigger:deploy:dry
git add geo-worker package.json package-lock.json
git commit -m "feat: migrate analysis worker to Trigger v4"
```

### Task 2: Add The Signed Ingestion Boundary

**Files:**
- Create: `src/lib/analysis/ingest-service.ts`
- Create: `src/lib/analysis/ingest-service.test.ts`
- Create: `src/app/api/internal/analysis-runs/[id]/artifacts/route.ts`
- Create: `src/app/api/internal/analysis-runs/[id]/artifacts/route.test.ts`
- Create: `src/app/api/internal/analysis-runs/ingest/route.ts`
- Create: `src/app/api/internal/analysis-runs/ingest/route.test.ts`

- [ ] **Step 1: Write failing ingestion tests**

Assert:

```typescript
await expect(service.ingest(clientAEnvelope)).resolves.toMatchObject({ duplicate: false });
await expect(service.ingest(clientAEnvelope)).resolves.toMatchObject({ duplicate: true });
await expect(service.ingest({ ...clientAEnvelope, clientId: "client_b" }))
  .rejects.toThrow("RUN_OWNERSHIP_MISMATCH");
await expect(service.ingest({ ...clientAEnvelope, rawArtifact: changedArtifact }))
  .rejects.toThrow("RUN_CHECKSUM_CONFLICT");
```

The route test must reject an absent or expired HMAC with `401`.

The artifact route test uploads raw bytes first and expects:

```typescript
expect(await uploadArtifact(bytes)).toMatchObject({
  uri: "artifact://run_1/report.json",
  checksum: "sha256:4f89b3c2d0e17a65",
  byteSize: bytes.byteLength,
});
```

- [ ] **Step 2: Implement ingestion**

`AnalysisIngestService`:

```typescript
export interface AnalysisIngestResult {
  runId: string;
  status: "accepted";
  duplicate: boolean;
}

export class AnalysisIngestService {
  constructor(
    private readonly repository: AnalysisRepository,
    private readonly artifacts: ArtifactStore,
  ) {}

  async ingest(envelope: AnalysisEnvelope): Promise<AnalysisIngestResult>;
}
```

In one transaction it validates run ownership, verifies that referenced
artifact metadata was already uploaded, inserts immutable observations,
updates the run status, and emits
`analysis_run.ingested`. A duplicate with the same payload hash is accepted;
a changed payload returns `409`.

The signed artifact route accepts `application/octet-stream`, requires
`x-sgeo-artifact-name` and `x-sgeo-artifact-sha256`, streams into
`ArtifactStore`, and returns the stored metadata. It rejects a checksum
mismatch with `422`. Workers never receive a local artifact filesystem path.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run src/lib/analysis/ingest-service.test.ts \
  src/app/api/internal/analysis-runs/ingest/route.test.ts
npm run typecheck
git add src/lib/analysis src/app/api/internal/analysis-runs
git commit -m "feat: ingest signed analysis results"
```

### Task 3: Implement The SiteOne Adapter

**Files:**
- Create: `geo-worker/src/adapters/siteone.ts`
- Create: `geo-worker/src/adapters/siteone.test.ts`
- Create: `geo-worker/src/tasks/siteone-crawl.ts`
- Create: `geo-worker/test/fixtures/siteone/*.json`
- Modify: `geo-worker/Dockerfile`

- [ ] **Step 1: Add six fixture states and failing contract tests**

Fixtures are named:

```text
success.json
partial.json
invalid.json
rate-limited.json
unauthorized.json
upstream-error.json
```

The success test expects normalized observations for HTTP status, indexability,
canonical mismatch, title, heading, structured data, and broken links.

- [ ] **Step 2: Implement process execution and normalization**

Expose:

```typescript
export interface SiteOneInput {
  runId: string;
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
  url: string;
  maxUrls: number;
  timeoutSeconds: number;
}

export async function runSiteOne(
  input: SiteOneInput,
  dependencies?: { execFile?: typeof import("node:child_process").execFile },
): Promise<AnalysisEnvelope>;
```

Invoke SiteOne Crawler `2.5.1` with explicit URL, URL limit, timeout, and JSON output
path. Never interpolate a shell command. Archive the untouched JSON before
normalization.

- [ ] **Step 3: Add the scheduled Trigger task**

The task reads a run intent from SGeoOps, executes the adapter, uploads the
artifact, and ingests the envelope. Configure:

```typescript
queue: { name: "siteone", concurrencyLimit: 2 },
machine: "medium-1x",
maxDuration: 900
```

- [ ] **Step 4: Verify and commit**

```bash
npm --workspace geo-worker test -- src/adapters/siteone.test.ts
npm --workspace geo-worker run typecheck
git add geo-worker/src/adapters/siteone* geo-worker/src/tasks/siteone-crawl.ts \
  geo-worker/test/fixtures/siteone geo-worker/Dockerfile
git commit -m "feat: add SiteOne technical audit adapter"
```

### Task 4: Implement The Unlighthouse Adapter

**Files:**
- Create: `geo-worker/src/adapters/unlighthouse.ts`
- Create: `geo-worker/src/adapters/unlighthouse.test.ts`
- Create: `geo-worker/src/tasks/unlighthouse-audit.ts`
- Create: `geo-worker/test/fixtures/unlighthouse/*.json`
- Modify: `geo-worker/trigger.config.ts`

- [ ] **Step 1: Write failing fixture tests**

The success fixture must create observations for performance, accessibility,
best practices, SEO, LCP, CLS, INP/TBT fallback, and template URL.

- [ ] **Step 2: Implement the adapter**

Run Unlighthouse CLI `0.18.0`:

```text
unlighthouse-ci --site "$SITE_URL" --reporter jsonExpanded --output-path "$OUTPUT_DIR"
```

through an argument array, not a shell. Limit the supplied route list to
configured representative templates. Return `partial` if one route fails and
at least one succeeds.

- [ ] **Step 3: Configure Chromium resources**

Use Trigger's supported Puppeteer/build extension, a dedicated temporary
directory, `concurrencyLimit: 1`, and `maxDuration: 900`. Do not mount the host
Docker socket.

- [ ] **Step 4: Verify and commit**

```bash
npm --workspace geo-worker test -- src/adapters/unlighthouse.test.ts
npm --workspace geo-worker run typecheck
git add geo-worker/src/adapters/unlighthouse* \
  geo-worker/src/tasks/unlighthouse-audit.ts \
  geo-worker/test/fixtures/unlighthouse geo-worker/trigger.config.ts
git commit -m "feat: add sampled Unlighthouse audits"
```

### Task 5: Implement Search Console Sync

**Files:**
- Create: `geo-worker/src/clients/search-console.ts`
- Create: `geo-worker/src/adapters/search-console.ts`
- Create: `geo-worker/src/adapters/search-console.test.ts`
- Create: `geo-worker/src/tasks/search-console-sync.ts`
- Create: `geo-worker/test/fixtures/search-console/*.json`

- [ ] **Step 1: Write failing pagination and delayed-data tests**

Assert that:

```typescript
expect(request.dimensions).toEqual(["date", "query", "page", "country", "device"]);
expect(request.rowLimit).toBe(25_000);
expect(nextRequest.startRow).toBe(25_000);
expect(observation.value).toMatchObject({ dataState: "final" });
```

- [ ] **Step 2: Implement the client and adapter**

Use the Search Analytics API with explicit `startDate`, `endDate`,
`dimensions`, `rowLimit`, and `startRow`. Store impressions, clicks, CTR,
position, and the response data state. Never label top rows as total
site-wide cardinality.

- [ ] **Step 3: Add daily scheduling and quota failure behavior**

`429` and quota `403` are retryable within the daily budget. Authentication
`401/403` disables the integration and creates an operator recommendation.

- [ ] **Step 4: Verify and commit**

```bash
npm --workspace geo-worker test -- src/adapters/search-console.test.ts
npm --workspace geo-worker run typecheck
git add geo-worker/src/clients/search-console.ts \
  geo-worker/src/adapters/search-console* \
  geo-worker/src/tasks/search-console-sync.ts \
  geo-worker/test/fixtures/search-console
git commit -m "feat: sync Search Console observations"
```

### Task 6: Deploy And Integrate Matomo

**Files:**
- Create: `geo-worker/src/clients/matomo.ts`
- Create: `geo-worker/src/adapters/matomo.ts`
- Create: `geo-worker/src/adapters/matomo.test.ts`
- Create: `geo-worker/src/tasks/matomo-sync.ts`
- Create: `geo-worker/test/fixtures/matomo/*.json`
- Modify: `docker-compose.yml`
- Modify: `deploy/docker-compose.prod.example.yml`
- Create: `deploy/backup-matomo.sh`

- [ ] **Step 1: Write failing analytics normalization tests**

The adapter must normalize:

```typescript
[
  { kind: "page_view", subject: "/pricing", value: { count: 120 } },
  { kind: "organic_visit", subject: "/pricing", value: { count: 60 } },
  { kind: "conversion", subject: "lead", value: { count: 5 } },
]
```

and preserve date range, site ID, segment, and timezone.

- [ ] **Step 2: Add isolated Matomo services**

Compose includes Matomo Core `5.12.0`, MariaDB, and archive cron containers.
Matomo has its own database, credentials, volume, network policy, and backup.
Only SGeoOps/worker can access the reporting API.

- [ ] **Step 3: Implement sync with token secrecy**

Resolve the Matomo token through Phase 1 `secretRef`. Send it only in the
request body or approved auth header, redact it from errors, and store raw
responses as artifacts.

- [ ] **Step 4: Verify and commit**

```bash
npm --workspace geo-worker test -- src/adapters/matomo.test.ts
docker compose config --quiet
bash -n deploy/backup-matomo.sh
git add geo-worker/src/clients/matomo.ts geo-worker/src/adapters/matomo* \
  geo-worker/src/tasks/matomo-sync.ts geo-worker/test/fixtures/matomo \
  docker-compose.yml deploy
git commit -m "feat: add Matomo analytics ingestion"
```

### Task 7: Calculate SEO Metrics And Opportunities

**Files:**
- Create: `src/lib/seo/metrics.ts`
- Create: `src/lib/seo/metrics.test.ts`
- Create: `src/lib/seo/opportunity-detectors.ts`
- Create: `src/lib/seo/opportunity-detectors.test.ts`
- Create: `src/lib/seo/report-queries.ts`

- [ ] **Step 1: Write failing formula-version tests**

Assert exact formulas:

```typescript
expect(calculateRate(92, 100)).toBe(0.92);
expect(calculateRate(0, 0)).toBeNull();
expect(priority({ businessValue: 5, expectedImpact: 4, confidence: 3, estimatedEffort: 2 }))
  .toBe(30);
expect(SEO_FORMULA_VERSION).toBe("seo-v1");
```

- [ ] **Step 2: Implement pure calculators**

Calculate crawl success, indexability, canonical health, metadata/heading
completeness, structured-data coverage, broken-link rate, sampled Lighthouse
scores, Search Console metrics, organic traffic, and conversions. Every result
includes `formulaVersion: "seo-v1"` and dimensions.

- [ ] **Step 3: Implement traceable detectors**

A recommendation contains observation IDs and one of:

```typescript
type SeoRecommendationKind =
  | "technical_fix"
  | "existing_page_improvement"
  | "new_content"
  | "measurement_repair";
```

Group recommendations by site, normalized subject, and kind. Store the
priority inputs and operator override separately.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/seo
npm run typecheck
git add src/lib/seo
git commit -m "feat: calculate SEO metrics and opportunities"
```

### Task 8: Add Scoped SEO Reports And Opportunity UI

**Files:**
- Create: SEO API, page, and component files listed in File Structure
- Modify: `src/components/geo-dashboard.tsx`

- [ ] **Step 1: Write failing report route tests**

Prove client isolation, date range validation, baseline selection, and empty
states. A Client A session requesting Client B's site returns `404`.

- [ ] **Step 2: Implement report queries**

Expose:

```typescript
export interface SeoReport {
  siteId: string;
  range: { from: string; to: string };
  baseline: { runId: string; capturedAt: string } | null;
  latest: { runId: string; capturedAt: string } | null;
  metrics: Array<{ name: string; value: number | null; delta: number | null }>;
  coverage: Array<{ source: string; status: string; lastRunAt: string | null }>;
}
```

- [ ] **Step 3: Build the operational UI**

The site SEO page contains compact summary metrics, source coverage, baseline
comparison, run history, and opportunity queue. Keep filters in the URL. Use
tables for repeated operational rows and no nested cards.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/app/api/sites src/lib/seo
npm run typecheck
npm run build
git add 'src/app/(ops)/sites' src/app/api/sites src/components/seo \
  src/components/opportunities src/components/geo-dashboard.tsx
git commit -m "feat: add scoped SEO reporting workspace"
```

### Task 9: Phase 2 Integration And Acceptance

**Files:**
- Create: `deploy/docker-compose.integration.yml`
- Create: `tests/integration/seo-loop.test.ts`
- Create: `deploy/trigger/README.md`
- Create: `deploy/trigger.env.example`
- Create: `deploy/backup-artifacts.sh`

- [ ] **Step 1: Build a deterministic fixture site**

The integration stack serves pages with:

```text
one healthy indexable page
one canonical mismatch
one broken link
one missing title
one structured-data page
one intentionally slow template
```

- [ ] **Step 2: Run the complete SEO loop**

```bash
docker compose -f deploy/docker-compose.integration.yml up --build \
  --abort-on-container-exit --exit-code-from integration-tests
```

Expected: SiteOne and Unlighthouse produce artifacts, SGeoOps ingests them,
metrics are versioned, and at least one observation-backed opportunity exists.

- [ ] **Step 3: Run the phase gate**

```bash
npm test
npm run test:integration
npm --workspace geo-worker test
npm --workspace geo-worker run typecheck
npm run typecheck
npm run build
docker compose config --quiet
bash -n deploy/backup-matomo.sh
bash -n deploy/backup-artifacts.sh
```

Expected: all commands exit `0`.

- [ ] **Step 4: Commit**

```bash
git add deploy tests/integration/seo-loop.test.ts
git commit -m "test: verify the end-to-end SEO loop"
```
