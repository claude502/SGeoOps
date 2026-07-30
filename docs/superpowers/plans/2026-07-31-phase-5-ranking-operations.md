# Phase 5 Ranking And Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add conditional keyword ranking, batch reporting, operational health, alerts, capacity enforcement, and production recovery evidence.

**Architecture:** SerpBear remains optional and enters through the same immutable observation contract as other sources. SGeoOps generates batch reports into ArtifactStore and evaluates in-app alerts from persisted health/metric data. Capacity limits and restore drills are enforced as auditable business operations rather than informal documentation.

**Tech Stack:** SerpBear, Trigger.dev v4, Next.js, Prisma, ArtifactStore, Vitest, Playwright, Docker Compose

---

## File Structure

Create:

```text
prisma/migrations/20260731160000_add_batch_reports/migration.sql
prisma/migrations/20260731170000_add_operational_alerts/migration.sql
prisma/migrations/20260731180000_add_capacity_reviews/migration.sql
geo-worker/src/clients/serpbear.ts
geo-worker/src/adapters/serpbear.ts
geo-worker/src/adapters/serpbear.test.ts
geo-worker/src/tasks/serpbear-sync.ts
geo-worker/src/tasks/batch-report.ts
geo-worker/src/tasks/operations-snapshot.ts
geo-worker/test/fixtures/serpbear/*.json
src/lib/ranking/metrics.ts
src/lib/ranking/metrics.test.ts
src/lib/ranking/report-queries.ts
src/lib/reports/batch-service.ts
src/lib/reports/batch-service.test.ts
src/lib/reports/csv-renderer.ts
src/lib/reports/csv-renderer.test.ts
src/lib/operations/health-query.ts
src/lib/operations/alert-evaluator.ts
src/lib/operations/alert-evaluator.test.ts
src/lib/operations/capacity-policy.ts
src/lib/operations/capacity-policy.test.ts
src/app/api/reports/batches/route.ts
src/app/api/reports/batches/[id]/route.ts
src/app/api/reports/batches/[id]/download/route.ts
src/app/api/internal/reports/batches/[id]/generate/route.ts
src/app/api/internal/operations/snapshot/route.ts
src/app/api/operations/health/route.ts
src/app/api/operations/alerts/route.ts
src/app/api/operations/capacity/route.ts
src/app/(ops)/reports/batches/page.tsx
src/app/(ops)/operations/page.tsx
src/components/reports/batch-report-table.tsx
src/components/operations/service-health.tsx
src/components/operations/alert-list.tsx
src/components/operations/capacity-summary.tsx
deploy/restore-test.sh
tests/integration/ranking-operations.test.ts
tests/e2e/operations.spec.ts
```

Modify:

```text
prisma/schema.prisma
docker-compose.yml
deploy/docker-compose.prod.example.yml
deploy/backup-postgres.sh
deploy/backup-matomo.sh
deploy/backup-artifacts.sh
src/lib/organization/repository.ts
```

### Task 1: Run The SerpBear Proof-Of-Concept Gate

**Files:**
- Create: `docs/serpbear-poc.md`
- Create: `geo-worker/src/clients/serpbear.ts`
- Create: `geo-worker/src/adapters/serpbear.ts`
- Create: `geo-worker/src/adapters/serpbear.test.ts`
- Create: `geo-worker/test/fixtures/serpbear/*.json`

- [ ] **Step 1: Record the approved data-source policy**

`docs/serpbear-poc.md` must record:

```text
approved SERP data source
license and terms review date
country/device/location support
daily request and monetary budget
retention limits
test domains and keywords
go/no-go owner and decision
```

Do not enable production tracking without a recorded `go` decision.

- [ ] **Step 2: Write failing adapter tests**

Fixtures cover success, partial, invalid, `429`, `401`, and `5xx`. A success
normalizes keyword, target URL, observed URL, position, country, device,
location, provider, and timestamp into `Observation`.

- [ ] **Step 3: Implement the injected-fetch adapter**

```typescript
export interface RankObservationInput {
  keywordId: string;
  keyword: string;
  targetUrl: string;
  country: string;
  device: "desktop" | "mobile";
  location?: string;
}
```

Use SerpBear `3.1.0`, the integration registry, and `secretRef`; preserve
untouched response JSON in ArtifactStore.

- [ ] **Step 4: Verify and commit**

```bash
npm --workspace geo-worker test -- src/adapters/serpbear.test.ts
npm --workspace geo-worker run typecheck
git add docs/serpbear-poc.md geo-worker/src/clients/serpbear.ts \
  geo-worker/src/adapters/serpbear* geo-worker/test/fixtures/serpbear
git commit -m "feat: validate the SerpBear ranking boundary"
```

### Task 2: Add Ranking Sync And Metrics

**Files:**
- Create: `geo-worker/src/tasks/serpbear-sync.ts`
- Create: `src/lib/ranking/metrics.ts`
- Create: `src/lib/ranking/metrics.test.ts`
- Create: `src/lib/ranking/report-queries.ts`
- Modify: `docker-compose.yml`
- Modify: `deploy/docker-compose.prod.example.yml`

- [ ] **Step 1: Write failing metric tests**

```typescript
expect(visibilityScore([{ position: 1 }, { position: 10 }, { position: 101 }]))
  .toBeGreaterThan(0);
expect(segmentKey({ country: "MY", device: "mobile" })).toBe("MY:mobile");
expect(RANK_FORMULA_VERSION).toBe("rank-v1");
```

- [ ] **Step 2: Add optional Compose profile**

Pin SerpBear behind:

```yaml
profiles: ["ranking"]
```

Keep it private, give it dedicated credentials/volume, and register its
endpoint through Phase 1 `Integration`.

- [ ] **Step 3: Implement scheduled sync and metrics**

Sync configured keywords daily or every three days. Calculate visibility,
top-3/top-10/top-20 coverage, average position, target URL match, winners, and
losers by country/device/site market. Store `formulaVersion: "rank-v1"`.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/ranking
npm --workspace geo-worker test -- src/tasks/serpbear-sync.test.ts
docker compose --profile ranking config --quiet
git add src/lib/ranking geo-worker/src/tasks/serpbear-sync.ts \
  docker-compose.yml deploy/docker-compose.prod.example.yml
git commit -m "feat: add segmented keyword ranking"
```

### Task 3: Add Batch Reports Through ArtifactStore

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260731160000_add_batch_reports/migration.sql`
- Create: batch report service, renderer, routes, and UI listed above
- Create: `src/app/api/internal/reports/batches/[id]/generate/route.ts`
- Create: `geo-worker/src/tasks/batch-report.ts`

- [ ] **Step 1: Write failing renderer tests**

```typescript
expect(renderCsv(report)).toContain("client,brand,site,market,metric,value,formula_version");
expect(renderCsv(report)).not.toContain("secretRef");
expect(renderCsv(report)).not.toContain("providerRawResponse");
```

- [ ] **Step 2: Add the batch model**

```prisma
model BatchReport {
  id           String   @id @default(cuid())
  workspaceId  String
  requestedById String
  format       String
  filters      Json
  status       String   @default("queued")
  artifactUri  String?
  checksum     String?
  errorSummary String?
  createdAt    DateTime @default(now())
  completedAt  DateTime?

  @@index([workspaceId, status, createdAt])
}
```

Generate and inspect:

```bash
npx prisma migrate dev --name add_batch_reports --create-only
npx prisma validate
```

- [ ] **Step 3: Implement generation and download**

The Trigger task invokes the signed
`/api/internal/reports/batches/[id]/generate` route and retries transport
failures. `BatchReportService` loads scoped data, renders CSV, writes it to
ArtifactStore, and records URI/checksum. Downloads require a current session
with the same workspace scope; never expose a local filesystem path.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/reports src/app/api/reports
npm --workspace geo-worker test -- src/tasks/batch-report.test.ts
npm run typecheck
git add prisma src/lib/reports src/app/api/reports \
  src/app/api/internal/reports \
  'src/app/(ops)/reports' src/components/reports \
  geo-worker/src/tasks/batch-report.ts
git commit -m "feat: generate scoped batch reports"
```

### Task 4: Add Health Snapshots And In-App Alerts

**Files:**
- Create: operations files, routes, and UI listed above
- Create: `geo-worker/src/tasks/operations-snapshot.ts`
- Create: `src/app/api/internal/operations/snapshot/route.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260731170000_add_operational_alerts/migration.sql`

- [ ] **Step 1: Write failing alert transition tests**

```typescript
expect(evaluateAlert(healthy, previousOpen)).toEqual({ action: "resolve" });
expect(evaluateAlert(failingThreeTimes, previousNone)).toEqual({ action: "open" });
expect(evaluateAlert(failingOnce, previousNone)).toEqual({ action: "none" });
```

- [ ] **Step 2: Add minimal alert models**

```prisma
model AlertRule {
  id          String   @id @default(cuid())
  workspaceId String
  name        String
  kind        String
  config      Json
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model AlertEvent {
  id          String   @id @default(cuid())
  ruleId      String
  state       String
  evidence    Json
  openedAt    DateTime
  resolvedAt  DateTime?

  @@index([ruleId, state])
}
```

Generate and inspect:

```bash
npx prisma migrate dev --name add_operational_alerts --create-only
npx prisma validate
```

- [ ] **Step 3: Implement health and alert evaluation**

Health covers SGeoOps DB, ArtifactStore, Trigger, GEOFlow, LiteLLM, Matomo,
SiteOne/Unlighthouse last-run age, Search Console last sync, and optional
SerpBear. Open alerts only after configured consecutive failures; resolve only
after a healthy check.

No Slack/email integration ships in this phase. External notifications require
a separately approved adapter.

`operations-snapshot` invokes the signed
`/api/internal/operations/snapshot` route. `health-query.ts` and
`alert-evaluator.ts` remain SGeoOps-owned business logic.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/operations src/app/api/operations
npm --workspace geo-worker test -- src/tasks/operations-snapshot.test.ts
npm run typecheck
git add prisma src/lib/operations src/app/api/operations \
  src/app/api/internal/operations \
  'src/app/(ops)/operations' src/components/operations \
  geo-worker/src/tasks/operations-snapshot.ts
git commit -m "feat: add operational health and alerts"
```

### Task 5: Enforce Capacity Review

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260731180000_add_capacity_reviews/migration.sql`
- Create: `src/lib/operations/capacity-policy.ts`
- Create: `src/lib/operations/capacity-policy.test.ts`
- Modify: `src/lib/organization/repository.ts`
- Create: `src/app/api/operations/capacity/route.ts`

- [ ] **Step 1: Write failing boundary tests**

```typescript
expect(canCreateClient({ clients: 9, sites: 50, approvedReview: false })).toBe(true);
expect(canCreateClient({ clients: 10, sites: 50, approvedReview: false })).toBe(false);
expect(canCreateSite({ clients: 10, sites: 50, approvedReview: true })).toBe(true);
```

- [ ] **Step 2: Add capacity review persistence**

```prisma
model CapacityReview {
  id           String   @id @default(cuid())
  workspaceId  String
  requestedById String
  reviewedById String?
  currentClients Int
  currentSites Int
  proposedClients Int
  proposedSites Int
  decision     String   @default("pending")
  notes        String?
  createdAt    DateTime @default(now())
  decidedAt    DateTime?
}
```

Generate and inspect:

```bash
npx prisma migrate dev --name add_capacity_reviews --create-only
npx prisma validate
```

- [ ] **Step 3: Enforce in the same creation transaction**

Client creation at 10 existing clients and site creation at 50 existing sites
requires an approved, unused review covering the proposed count. Consume the
review and create the entity atomically with an audit event.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/operations/capacity-policy.test.ts \
  src/lib/organization/repository.test.ts
npm run typecheck
git add prisma src/lib/operations/capacity-policy* \
  src/lib/organization/repository.ts src/app/api/operations/capacity
git commit -m "feat: require review beyond platform capacity"
```

### Task 6: Prove Backup And Restore

**Files:**
- Modify: backup scripts listed in File Structure
- Create: `deploy/restore-test.sh`
- Create: `tests/integration/ranking-operations.test.ts`
- Create: `tests/e2e/operations.spec.ts`

- [ ] **Step 1: Update retention and encrypted off-host copies**

Back up SGeoOps PostgreSQL, Matomo MariaDB, artifact metadata, and artifact
files daily. Encrypt before off-host transfer. Retain backups for 30 days,
raw evidence for 180 days, and published snapshots/audit events indefinitely
unless a client policy requires deletion.

- [ ] **Step 2: Implement a disposable restore drill**

`deploy/restore-test.sh`:

```text
creates isolated temporary databases and artifact root
restores the newest encrypted backups
runs Prisma validation and row-count checks
verifies one artifact checksum and one published snapshot
destroys only the disposable restore environment
writes a timestamped pass/fail evidence file
```

The script must require an explicit `RESTORE_TEST=true` guard.

- [ ] **Step 3: Run full acceptance**

```bash
npm test
npm run test:integration
npx playwright test tests/e2e/operations.spec.ts
npm --workspace geo-worker test
npm run typecheck
npm run build
docker compose --profile ranking config --quiet
bash -n deploy/backup-postgres.sh
bash -n deploy/backup-matomo.sh
bash -n deploy/backup-artifacts.sh
bash -n deploy/restore-test.sh
RESTORE_TEST=true ./deploy/restore-test.sh
```

Expected: all commands exit `0` and the restore drill writes successful
evidence.

- [ ] **Step 4: Commit**

```bash
git add deploy tests/integration/ranking-operations.test.ts \
  tests/e2e/operations.spec.ts
git commit -m "test: prove ranking operations and disaster recovery"
```
