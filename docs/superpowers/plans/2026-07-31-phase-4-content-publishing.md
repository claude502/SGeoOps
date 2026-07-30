# Phase 4 Content And Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn evidence-backed opportunities into versioned GEOFlow content that can be reviewed, published to hosted/WordPress/Webflow/custom API destinations, and verified without duplicate or unsafe publication.

**Architecture:** GEOFlow remains the editable content and distribution engine. SGeoOps stores briefs, workflow references, immutable approval/publication snapshots, risk decisions, publish intent, attempts, and verification evidence. Trigger.dev only polls cross-system state and verifies remote outcomes; it does not duplicate GEOFlow's generation or publishing queues.

**Tech Stack:** GEOFlow HTTP API, Next.js, Prisma, Zod, Trigger.dev v4, Node.js crypto, Vitest, Playwright

---

## File Structure

Create:

```text
prisma/migrations/20260731140000_add_content_publishing/migration.sql
prisma/migrations/20260731150000_backfill_content_snapshots/migration.sql
src/lib/content/briefs.ts
src/lib/content/briefs.test.ts
src/lib/content/snapshots.ts
src/lib/content/snapshots.test.ts
src/lib/geoflow/integration-resolver.ts
src/lib/geoflow/destinations.ts
src/lib/publishing/risk-policy.ts
src/lib/publishing/risk-policy.test.ts
src/lib/publishing/quality-gates.ts
src/lib/publishing/quality-gates.test.ts
src/lib/publishing/state-machine.ts
src/lib/publishing/state-machine.test.ts
src/lib/publishing/idempotency.ts
src/lib/publishing/idempotency.test.ts
src/lib/publishing/repository.ts
src/lib/publishing/service.ts
src/lib/publishing/verification.ts
src/lib/publishing/verification.test.ts
src/app/api/content-assets/[id]/briefs/route.ts
src/app/api/content-assets/[id]/geoflow-task/route.ts
src/app/api/content-assets/[id]/risk-evaluation/route.ts
src/app/api/content-assets/[id]/reviews/route.ts
src/app/api/content-assets/[id]/publish-jobs/route.ts
src/app/api/publish-jobs/[id]/route.ts
src/app/api/publish-jobs/[id]/retry/route.ts
src/app/api/webhooks/geoflow/route.ts
src/app/api/webhooks/geoflow/route.test.ts
src/app/api/internal/publish-jobs/[id]/verify/route.ts
src/app/api/internal/publish-jobs/[id]/verify/route.test.ts
geo-worker/src/tasks/geoflow-poll.ts
geo-worker/src/tasks/publish-verify.ts
src/app/(ops)/content/[id]/page.tsx
src/components/content/content-workflow.tsx
src/components/content/risk-decision.tsx
src/components/content/publish-destinations.tsx
src/components/content/delivery-attempts.tsx
tests/integration/content-publishing.test.ts
tests/e2e/multi-site-publishing.spec.ts
```

Modify:

```text
prisma/schema.prisma
src/lib/geoflow/client.ts
src/lib/geoflow/bridge-service.ts
src/lib/geoflow/bridge-service.test.ts
src/lib/geoflow/repository.ts
src/lib/geoflow/config.ts
src/lib/content-assets.ts
src/lib/site-context.ts
src/lib/txpuro.ts
src/app/guides/[[...slug]]/page.tsx
src/app/llms.txt/route.ts
src/app/sitemap-guides.xml/route.ts
src/app/robots.txt/route.ts
middleware.ts
.env.example
```

### Task 1: Add Versioned Content And Publishing Models

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260731140000_add_content_publishing/migration.sql`

- [ ] **Step 1: Add a failing state-model schema test**

```typescript
for (const model of [
  "ContentBrief", "ContentSnapshot", "RiskPolicy", "ReviewDecision",
  "PublishJob", "DeliveryAttempt",
]) {
  expect(schema).toContain(`model ${model} {`);
}
```

- [ ] **Step 2: Add enums and models**

Add:

```prisma
enum RiskLevel {
  low
  high
  inconclusive
}

enum PublishJobStatus {
  queued
  awaiting_review
  approved
  publishing
  verifying
  succeeded
  partial
  failed
  cancelled
}

model ContentBrief {
  id              String   @id @default(cuid())
  contentAssetId  String
  opportunityId   String?
  version         Int
  payload         Json
  expectedOutcome Json
  createdById     String
  createdAt       DateTime @default(now())

  @@unique([contentAssetId, version])
}

model ContentSnapshot {
  id                String   @id @default(cuid())
  contentAssetId    String
  version           Int
  geoFlowVersion    String?
  kind              String
  title             String
  body              String
  citations         Json
  checksum          String
  reviewerId        String?
  riskLevel         RiskLevel
  riskDecisionId    String?
  createdAt         DateTime @default(now())

  @@unique([contentAssetId, version, kind])
  @@index([contentAssetId, createdAt])
}

model RiskPolicy {
  id              String   @id @default(cuid())
  brandId         String
  siteMarketId    String?
  version         Int
  sensitiveTopics String[]
  autoPublishMax  RiskLevel @default(low)
  qualityRules    Json
  active          Boolean  @default(true)
  createdAt       DateTime @default(now())

  @@unique([brandId, siteMarketId, version])
}

model ReviewDecision {
  id                String    @id @default(cuid())
  contentAssetId    String
  contentSnapshotId String
  reviewerId        String
  decision          String
  riskLevel         RiskLevel
  reason            String
  createdAt         DateTime  @default(now())

  @@index([contentAssetId, createdAt])
}

model PublishJob {
  id                String           @id @default(cuid())
  clientId          String
  siteId            String
  contentAssetId    String
  contentSnapshotId String
  destination       String
  integrationId     String
  idempotencyKey    String           @unique
  status            PublishJobStatus @default(queued)
  remoteContentId   String?
  remoteUrl          String?
  verificationRunId String?
  createdById       String
  createdAt         DateTime         @default(now())
  updatedAt         DateTime         @updatedAt
  attempts          DeliveryAttempt[]

  @@index([clientId, siteId, status])
}

model DeliveryAttempt {
  id             String   @id @default(cuid())
  publishJobId   String
  attemptNumber  Int
  requestHash    String
  responseStatus Int?
  retryAt        DateTime?
  remoteContentId String?
  remoteUrl      String?
  errorCode      String?
  errorSummary   String?
  startedAt      DateTime @default(now())
  finishedAt     DateTime?
  publishJob     PublishJob @relation(fields: [publishJobId], references: [id], onDelete: Cascade)

  @@unique([publishJobId, attemptNumber])
}
```

Add `sourceSystem`, `externalContentId`, `workflowStatus`, `riskLevel`,
`latestApprovedSnapshotId`, and `latestPublishedSnapshotId` to `ContentAsset`.

- [ ] **Step 3: Generate and verify the migration**

```bash
npx prisma format
npx prisma validate
npx prisma migrate dev --name add_content_publishing --create-only
npx vitest run tests/integration/schema-contract.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add prisma tests/integration/schema-contract.test.ts
git commit -m "feat: add content publishing workflow models"
```

### Task 2: Create Immutable Snapshots And Backfill Existing Content

**Files:**
- Create: `src/lib/content/snapshots.ts`
- Create: `src/lib/content/snapshots.test.ts`
- Create: `prisma/migrations/20260731150000_backfill_content_snapshots/migration.sql`

- [ ] **Step 1: Write failing canonical checksum tests**

```typescript
const first = createSnapshotPayload(input);
const second = createSnapshotPayload({ ...input, citations: [...input.citations].reverse() });
expect(first.checksum).toBe(second.checksum);
expect(createSnapshotPayload({ ...input, body: `${input.body} changed` }).checksum)
  .not.toBe(first.checksum);
```

- [ ] **Step 2: Implement deterministic serialization**

Normalize line endings to `\n`, trim trailing whitespace, sort citation keys
and URLs, serialize UTF-8 JSON with stable key order, and calculate SHA-256.

```typescript
export interface SnapshotPayload {
  title: string;
  body: string;
  citations: Array<{ url: string; title?: string }>;
  checksum: string;
}
```

- [ ] **Step 3: Backfill published legacy bodies**

For every public legacy `ContentAsset`, insert one `published` snapshot using
its exact title, body, canonical URL, and timestamps. Map existing GEOFlow
links, export packages, and dispatch remote IDs without changing any URL.
Abort if two different bodies would receive the same content version.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/content/snapshots.test.ts
npm run test:integration -- tests/integration/txpuro-backfill.test.ts
git add src/lib/content/snapshots* prisma/migrations/20260731150000_backfill_content_snapshots
git commit -m "feat: snapshot existing approved and published content"
```

### Task 3: Persist Evidence-Backed Briefs

**Files:**
- Create: `src/lib/content/briefs.ts`
- Create: `src/lib/content/briefs.test.ts`
- Create: `src/app/api/content-assets/[id]/briefs/route.ts`

- [ ] **Step 1: Write failing brief traceability tests**

```typescript
expect(brief).toMatchObject({
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: "market_1",
  opportunityId: "opp_1",
  observationIds: ["obs_1", "obs_2"],
  expectedOutcome: { metric: "citation_rate", direction: "increase" },
});
```

- [ ] **Step 2: Implement brief construction**

Reject observations outside the content asset's client/site scope. Persist
brand aliases, market, target keyword/prompt, source evidence, citations,
constraints, expected metric outcome, and brief version.

- [ ] **Step 3: Implement the scoped route**

`Admin` and `Operator` may create briefs. `Reviewer` and `Viewer` may read.
Write the brief and audit event in one transaction.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/content/briefs.test.ts \
  src/app/api/content-assets/[id]/briefs/route.test.ts
npm run typecheck
git add src/lib/content/briefs* src/app/api/content-assets
git commit -m "feat: create evidence-backed content briefs"
```

### Task 4: Implement Risk, Quality, And Publication State Machines

**Files:**
- Create: risk, quality, state-machine, and idempotency files listed above

- [ ] **Step 1: Write failing fail-closed risk tests**

```typescript
expect(evaluateRisk({ category: "legal", confidence: 1 })).toEqual({
  level: "high",
  autoPublish: false,
  reasons: ["sensitive_category"],
});
expect(evaluateRisk({ category: "standard", confidence: null }).level).toBe("inconclusive");
expect(canAutoPublish({ risk: "inconclusive", gates: [] })).toBe(false);
```

- [ ] **Step 2: Write failing quality-gate tests**

Automatic publication must fail when any of these are unavailable or false:

```typescript
[
  "citations_accessible",
  "fact_check_clear",
  "geo_threshold",
  "seo_threshold",
  "canonical_valid",
  "path_allowed",
  "destination_healthy",
  "version_not_published",
]
```

- [ ] **Step 3: Implement pure policy functions**

```typescript
export interface GateResult {
  name: string;
  status: "pass" | "fail" | "unknown";
  evidenceIds: string[];
}

export interface PublicationDecision {
  outcome: "auto_publish" | "review" | "blocked";
  riskLevel: "low" | "high" | "inconclusive";
  gates: GateResult[];
  policyVersion: number;
}
```

`unknown` always routes to review.

- [ ] **Step 4: Implement allowed transitions**

```typescript
const transitions = {
  queued: ["awaiting_review", "approved", "cancelled"],
  awaiting_review: ["approved", "cancelled"],
  approved: ["publishing", "cancelled"],
  publishing: ["verifying", "partial", "failed"],
  verifying: ["succeeded", "partial", "failed"],
  partial: ["publishing", "cancelled"],
  failed: ["publishing", "cancelled"],
  succeeded: [],
  cancelled: [],
} as const;
```

The idempotency key is exactly:

```text
clientId:siteId:contentAssetId:contentVersion:destination
```

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/publishing
npm run typecheck
git add src/lib/publishing
git commit -m "feat: add fail-closed publication policy"
```

### Task 5: Upgrade The GEOFlow Bridge For Site-Scoped Versions

**Files:**
- Modify: `src/lib/geoflow/client.ts`
- Modify: `src/lib/geoflow/bridge-service.ts`
- Modify: `src/lib/geoflow/bridge-service.test.ts`
- Modify: `src/lib/geoflow/repository.ts`
- Modify: `src/lib/geoflow/config.ts`
- Create: `src/lib/geoflow/integration-resolver.ts`
- Create: `src/lib/geoflow/destinations.ts`
- Create: `src/app/api/content-assets/[id]/geoflow-task/route.ts`

- [ ] **Step 1: Add failing multi-site and version tests**

Prove:

```typescript
expect(resolveGeoFlowIntegration(siteA)).not.toEqual(resolveGeoFlowIntegration(siteB));
expect(task.idempotencyKey).toBe("site_a:asset_1:brief_2");
expect(syncResult.geoFlowVersion).toBe("article_version_3");
expect(syncResult).not.toHaveProperty("overwriteCanonicalUrl");
```

- [ ] **Step 2: Resolve integrations from the registry**

Remove global catalog IDs from request-time behavior. Resolve endpoint,
capabilities, catalog IDs, and token `secretRef` by site and market.

- [ ] **Step 3: Extend the client through its injected-fetch seam**

Add typed methods for task creation, job/article version status, review state,
publication request, remote update/delete, and callback verification. Preserve
`GeoFlowHttpError` classification and safe messages.

- [ ] **Step 4: Normalize destinations**

```typescript
export type GeoFlowDestination =
  | { type: "hosted"; siteId: string }
  | { type: "wordpress"; integrationId: string }
  | { type: "webflow"; integrationId: string }
  | { type: "custom_http"; integrationId: string };
```

SGeoOps submits destination intents to GEOFlow. It does not implement a second
WordPress/Webflow queue.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/geoflow
npm run typecheck
git add src/lib/geoflow src/app/api/content-assets
git commit -m "feat: scope GEOFlow tasks and destinations by site"
```

### Task 6: Implement Publish Jobs, Callbacks, And Retries

**Files:**
- Create: `src/lib/publishing/repository.ts`
- Create: `src/lib/publishing/service.ts`
- Create: publish-job routes listed in File Structure
- Create: `src/app/api/webhooks/geoflow/route.ts`
- Create: `src/app/api/webhooks/geoflow/route.test.ts`
- Create: `geo-worker/src/tasks/geoflow-poll.ts`

- [ ] **Step 1: Write failing idempotency and callback tests**

Test:

```typescript
expect(await publishSameVersionTwice()).toHaveLength(1);
await expect(publishSameKeyWithDifferentChecksum()).rejects.toThrow("IDEMPOTENCY_CONFLICT");
expect(await receiveCallbackTwice("event_1")).toEqual(["processed", "duplicate"]);
expect(await receiveOlderCallbackAfterPublished()).toBe("ignored_out_of_order");
```

- [ ] **Step 2: Implement transactional publication intent**

In one transaction create `PublishJob`, first `DeliveryAttempt`, audit event,
and outbox event. The service accepts only an approved immutable snapshot.

- [ ] **Step 3: Implement authenticated callbacks**

Verify the GEOFlow webhook secret, claim `InboxEvent`, validate the remote
content/version IDs, and apply only forward state transitions. Store safe
response metadata, never credentials or full article content.

- [ ] **Step 4: Implement retry classification**

Network/`5xx`: exponential backoff with jitter, maximum three attempts.
`429`: honor `Retry-After`. `401/403`: disable integration. Validation `4xx`:
fail immediately. Exhausted attempts enter `failed` and require operator
replay.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/publishing src/app/api/webhooks/geoflow
npm --workspace geo-worker test -- src/tasks/geoflow-poll.test.ts
npm run typecheck
git add src/lib/publishing src/app/api/publish-jobs \
  src/app/api/webhooks geo-worker/src/tasks/geoflow-poll.ts
git commit -m "feat: orchestrate idempotent GEOFlow publications"
```

### Task 7: Verify Remote Publications

**Files:**
- Create: `src/lib/publishing/verification.ts`
- Create: `src/lib/publishing/verification.test.ts`
- Create: `src/app/api/internal/publish-jobs/[id]/verify/route.ts`
- Create: `src/app/api/internal/publish-jobs/[id]/verify/route.test.ts`
- Create: `geo-worker/src/tasks/publish-verify.ts`

- [ ] **Step 1: Write failing verification tests**

```typescript
expect(await verify(healthyPage)).toMatchObject({ status: "succeeded" });
expect(await verify(canonicalMismatch)).toMatchObject({
  status: "failed",
  failures: ["canonical_mismatch"],
  deleteRemote: false,
});
```

- [ ] **Step 2: Implement checks**

Verify HTTP `200`, canonical, robots/indexability, structured data, checksum
when deterministic retrieval exists, sitemap, `llms.txt`, remote content ID,
and final URL. Store response bodies/reports as artifacts.

- [ ] **Step 3: Implement remediation**

Failure transitions the job to `failed` or `partial`, creates a high-priority
recommendation, and preserves remote identifiers. Never delete automatically.

The signed internal route resolves the publish job and runs
`verifyPublication()`. The Trigger task contains no publishing business logic;
it invokes this route and classifies retryable transport failures.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/publishing/verification.test.ts
npx vitest run src/app/api/internal/publish-jobs/[id]/verify/route.test.ts
npm --workspace geo-worker test -- src/tasks/publish-verify.test.ts
git add src/lib/publishing/verification* src/app/api/internal/publish-jobs \
  geo-worker/src/tasks/publish-verify.ts
git commit -m "feat: verify published content and preserve evidence"
```

### Task 8: Generalize Hosted Public Routes

**Files:**
- Modify: public route and site-context files listed in File Structure
- Create: public route tests

- [ ] **Step 1: Snapshot current Txpuro URLs**

The test fixture contains every current Txpuro path, locale, canonical URL,
sitemap URL, and `llms.txt` entry. Run the existing app before the change and
store only expected URLs/metadata, not rendered copyrighted body text.

- [ ] **Step 2: Resolve host and content through database configuration**

Public routes call `resolvePublicSite(host)` and look up the latest published
snapshot scoped by site, locale, and slug. Unknown hosts and cross-site slugs
return `404`.

- [ ] **Step 3: Preserve compatibility wrappers**

All Txpuro snapshot assertions remain unchanged. New sites use their own
canonical host, path policy, sitemap, robots, and `llms.txt`.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/site-context.test.ts src/lib/txpuro.test.ts \
  src/app/guides src/app/llms.txt src/app/sitemap-guides.xml src/app/robots.txt
npm run build
git add src/lib/site-context.ts src/lib/txpuro.ts src/app middleware.ts
git commit -m "feat: host published content for multiple sites"
```

### Task 9: Add Review And Delivery UI

**Files:**
- Create: risk/review routes and UI files listed in File Structure

- [ ] **Step 1: Write failing role tests**

Operator may request publication but cannot approve a high-risk snapshot.
Reviewer and Admin may approve; Viewer is read-only.

- [ ] **Step 2: Implement the workflow view**

Show brief evidence, GEOFlow version, immutable snapshot checksum, risk
reasons, gate results, review history, destination health, publish state,
attempts, remote URL, and verification evidence. Actions appear only when the
role and state permit them.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run src/app/api/content-assets src/app/api/publish-jobs
npm run typecheck
npm run build
git add 'src/app/(ops)/content' src/components/content src/app/api/content-assets
git commit -m "feat: add content review and delivery workspace"
```

### Task 10: Phase 4 Acceptance

**Files:**
- Create: `tests/integration/content-publishing.test.ts`
- Create: `tests/e2e/multi-site-publishing.spec.ts`

- [ ] **Step 1: Exercise required failures**

Test provider `429`, GEOFlow outage, duplicate callback, publish success plus
callback failure, remote checksum mismatch, and one failed target in a
multi-target job.

- [ ] **Step 2: Run the canonical workflow**

```text
opportunity -> brief -> GEOFlow draft -> snapshot -> risk evaluation
-> review or auto-approval -> hosted and external publication
-> verification -> before/after monitoring link
```

- [ ] **Step 3: Run the phase gate**

```bash
npm test
npm run test:integration
npx playwright test tests/e2e/multi-site-publishing.spec.ts
npm --workspace geo-worker test
npm run typecheck
npm run build
```

Expected: all pass, duplicate requests produce one remote entity, high-risk
content cannot auto-publish, and every Txpuro URL remains unchanged.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/content-publishing.test.ts \
  tests/e2e/multi-site-publishing.spec.ts
git commit -m "test: verify multi-site content publication"
```
