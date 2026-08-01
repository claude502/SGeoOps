# Phase 1 Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Txpuro-specific global state with authenticated, tenant-scoped platform foundations while preserving all existing Txpuro URLs and data.

**Architecture:** Add the organization hierarchy and common evidence models through expand/backfill/contract migrations. Better Auth provides internal identity and sessions; application-owned membership records provide the four approved roles. All business reads and writes go through an `AccessScope`, and all external workers use signed HTTP contracts instead of direct database access.

**Tech Stack:** Next.js App Router, TypeScript, Prisma 7, PostgreSQL, Better Auth, Zod, Vitest, Playwright, Node.js crypto/fs

---

## File Structure

Create:

```text
packages/analysis-contract/
  package.json
  src/index.ts
  src/index.test.ts
packages/internal-protocol/
  package.json
  src/index.ts
  src/index.test.ts
scripts/bootstrap-admin.ts
src/lib/auth.ts
src/lib/auth-client.ts
src/lib/authorization.ts
src/lib/authorization.test.ts
src/lib/internal-auth.ts
src/lib/organization/schemas.ts
src/lib/organization/repository.ts
src/lib/organization/repository.test.ts
src/lib/organization/scope.ts
src/lib/integrations/repository.ts
src/lib/integrations/secret-resolver.ts
src/lib/integrations/secret-resolver.test.ts
src/lib/artifacts/store.ts
src/lib/artifacts/local-store.ts
src/lib/artifacts/local-store.test.ts
src/lib/analysis/repository.ts
src/lib/events/outbox.ts
src/lib/events/inbox.ts
src/lib/events/events.test.ts
src/app/api/auth/[...all]/route.ts
src/app/login/page.tsx
src/app/(ops)/layout.tsx
src/app/(ops)/clients/page.tsx
src/app/api/clients/route.ts
src/app/api/clients/[clientId]/brands/route.ts
src/app/api/brands/[brandId]/sites/route.ts
src/app/api/sites/[siteId]/markets/route.ts
src/app/api/sites/[siteId]/integrations/route.ts
tests/integration/client-isolation.test.ts
tests/integration/txpuro-backfill.test.ts
vitest.integration.config.ts
prisma/migrations/20260731090000_platform_foundation_expand/migration.sql
prisma/migrations/20260731100000_backfill_txpuro_ownership/migration.sql
prisma/migrations/20260731110000_enforce_platform_scope/migration.sql
```

Modify:

```text
package.json
package-lock.json
prisma/schema.prisma
prisma/seed.mjs
middleware.ts
src/lib/prisma.ts
src/lib/audit-log.ts
src/lib/content-assets.ts
src/lib/dashboard-snapshot.ts
src/lib/site-context.ts
src/lib/txpuro.ts
src/types/geo.ts
src/app/page.tsx
src/components/geo-dashboard.tsx
all existing business API routes under src/app/api/
.env.example
docker-compose.yml
deploy/docker-compose.prod.example.yml
README.md
```

Keep `src/lib/basic-auth.ts` and its tests until the Better Auth cutover test
passes. Delete them only in Task 10.

### Task 1: Reproduce The Baseline

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the locked dependency graph**

Run:

```bash
npm ci
```

Expected: `node_modules` is created and npm exits `0`.

- [ ] **Step 2: Run the unmodified baseline**

Run:

```bash
npm run prisma:generate
npm test
npm run typecheck
npm run build
docker compose config --quiet
```

Expected: all commands exit `0`. If one fails, record the exact failure in the
task notes and fix it in a separate `fix: restore project baseline` commit
before continuing.

- [ ] **Step 3: Add workspace and test scripts**

Add these fields to `package.json`:

```json
{
  "workspaces": ["geo-worker", "packages/*"],
  "scripts": {
    "test:unit": "vitest run",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "verify": "npm run prisma:generate && npm run test:unit && npm run typecheck && npm run build"
  }
}
```

Run:

```bash
npm install
npm run test:unit
```

Expected: lockfile contains the workspace graph and the existing suite passes.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: establish platform workspace baseline"
```

### Task 2: Create The Shared Analysis Contract

**Files:**
- Create: `packages/analysis-contract/package.json`
- Create: `packages/analysis-contract/src/index.ts`
- Create: `packages/analysis-contract/src/index.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing contract tests**

Create `packages/analysis-contract/src/index.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { analysisEnvelopeSchema } from "./index";

const validEnvelope = {
  contractVersion: "1",
  runId: "run_1",
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: "market_1",
  source: "siteone",
  sourceVersion: "2.5.1",
  adapterVersion: "1.0.0",
  status: "succeeded",
  startedAt: "2026-07-31T01:00:00.000Z",
  finishedAt: "2026-07-31T01:05:00.000Z",
  rawArtifact: {
    uri: "artifact://run_1/report.json",
    checksum: "sha256:4f89b3c2d0e17a65",
    mediaType: "application/json",
    byteSize: 128,
  },
  observations: [{
    kind: "http_status",
    subject: "https://example.com/",
    value: { status: 200 },
    observedAt: "2026-07-31T01:04:00.000Z",
  }],
  error: null,
};

describe("analysisEnvelopeSchema", () => {
  it("accepts a versioned owned result", () => {
    expect(analysisEnvelopeSchema.parse(validEnvelope)).toEqual(validEnvelope);
  });

  it("rejects a result without site ownership", () => {
    const { siteId: _siteId, ...invalid } = validEnvelope;
    expect(analysisEnvelopeSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires an error for a failed result", () => {
    expect(analysisEnvelopeSchema.safeParse({
      ...validEnvelope,
      status: "failed",
      error: null,
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npx vitest run packages/analysis-contract/src/index.test.ts
```

Expected: FAIL because `./index` does not exist.

- [ ] **Step 3: Implement the package and Zod contract**

Create `packages/analysis-contract/package.json`:

```json
{
  "name": "@sgeo/analysis-contract",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "zod": "4.4.2"
  }
}
```

Create `packages/analysis-contract/src/index.ts`:

```typescript
import { z } from "zod";

export const analysisStatusSchema = z.enum([
  "queued", "running", "succeeded", "partial",
  "retrying", "failed", "cancelled",
]);

export const observationSurfaceSchema = z.enum(["api", "consumer_ui", "manual"]);

export const normalizedObservationSchema = z.object({
  kind: z.string().min(1),
  subject: z.string().min(1),
  value: z.record(z.string(), z.unknown()),
  observedAt: z.string().datetime(),
  surface: observationSurfaceSchema.optional(),
});

export const analysisEnvelopeSchema = z.object({
  contractVersion: z.literal("1"),
  runId: z.string().min(1),
  clientId: z.string().min(1),
  brandId: z.string().min(1),
  siteId: z.string().min(1),
  siteMarketId: z.string().min(1).nullable(),
  source: z.string().min(1),
  sourceVersion: z.string().min(1),
  adapterVersion: z.string().min(1),
  status: analysisStatusSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  rawArtifact: z.object({
    uri: z.string().min(1),
    checksum: z.string().regex(/^sha256:[a-f0-9]+$/),
    mediaType: z.string().min(1),
    byteSize: z.number().int().nonnegative(),
  }).nullable(),
  observations: z.array(normalizedObservationSchema),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  }).nullable(),
}).superRefine((value, context) => {
  if (value.status === "failed" && value.error === null) {
    context.addIssue({
      code: "custom",
      path: ["error"],
      message: "failed envelopes require an error",
    });
  }
});

export type AnalysisEnvelope = z.infer<typeof analysisEnvelopeSchema>;
export type NormalizedObservation = z.infer<typeof normalizedObservationSchema>;
```

- [ ] **Step 4: Run the test and commit**

Run:

```bash
npx vitest run packages/analysis-contract/src/index.test.ts
npm run typecheck
```

Expected: PASS.

```bash
git add package.json package-lock.json packages/analysis-contract
git commit -m "feat: add versioned analysis adapter contract"
```

### Task 3: Expand The Platform Schema

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260731090000_platform_foundation_expand/migration.sql`

- [ ] **Step 1: Add a failing schema assertion**

Create `tests/integration/schema-contract.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("platform Prisma schema", () => {
  it("contains ownership, evidence, auth, and event models", async () => {
    const schema = await readFile("prisma/schema.prisma", "utf8");
    for (const model of [
      "Workspace", "Client", "Brand", "Site", "SiteMarket", "Competitor", "Keyword",
      "User", "Session", "Account", "Verification", "WorkspaceMember",
      "Integration", "AnalysisRun", "RawArtifact", "Observation",
      "MetricSnapshot", "Recommendation", "Opportunity",
      "OpportunityRecommendation", "OutboxEvent", "InboxEvent",
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
  });
});
```

Run:

```bash
npx vitest run tests/integration/schema-contract.test.ts
```

Expected: FAIL on `Workspace`.

- [ ] **Step 2: Add enums and organization/auth models**

Add these declarations to `prisma/schema.prisma`:

```prisma
enum MemberRole {
  Admin
  Operator
  Reviewer
  Viewer
}

enum RunStatus {
  queued
  running
  succeeded
  partial
  retrying
  failed
  cancelled
}

model Workspace {
  id          String            @id @default(cuid())
  name        String
  slug        String            @unique
  clients     Client[]
  members     WorkspaceMember[]
  createdAt   DateTime          @default(now())
  updatedAt   DateTime          @updatedAt
}

model User {
  id            String            @id
  name          String
  email         String            @unique
  emailVerified Boolean           @default(false)
  image         String?
  sessions      Session[]
  accounts      Account[]
  memberships   WorkspaceMember[]
  createdAt     DateTime          @default(now())
  updatedAt     DateTime          @updatedAt
}

model Session {
  id        String   @id
  expiresAt DateTime
  token     String   @unique
  ipAddress String?
  userAgent String?
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId])
}

model Account {
  id                    String    @id
  accountId             String
  providerId            String
  userId                String
  user                  User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  accessToken           String?
  refreshToken          String?
  idToken               String?
  accessTokenExpiresAt  DateTime?
  refreshTokenExpiresAt DateTime?
  scope                 String?
  password              String?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  @@unique([providerId, accountId])
  @@index([userId])
}

model Verification {
  id         String   @id
  identifier String
  value      String
  expiresAt  DateTime
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@index([identifier])
}

model WorkspaceMember {
  id          String     @id @default(cuid())
  workspaceId String
  userId      String
  role        MemberRole
  workspace   Workspace  @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user        User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt

  @@unique([workspaceId, userId])
  @@index([userId, role])
}

model Client {
  id          String    @id @default(cuid())
  workspaceId String
  name        String
  slug        String
  active      Boolean   @default(true)
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Restrict)
  brands      Brand[]
  analysisRuns AnalysisRun[]
  recommendations Recommendation[]
  opportunities Opportunity[]
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@unique([workspaceId, slug])
  @@index([workspaceId, active])
}

model Brand {
  id          String   @id @default(cuid())
  clientId    String
  name        String
  slug        String
  aliases     String[]
  products    Json?
  industry    String?
  goals       Json?
  riskCategory String   @default("standard")
  client      Client    @relation(fields: [clientId], references: [id], onDelete: Restrict)
  sites       Site[]
  competitors Competitor[]
  analysisRuns AnalysisRun[]
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@unique([clientId, slug])
  @@index([clientId])
}

model Site {
  id                 String       @id @default(cuid())
  brandId            String
  name               String
  canonicalHost      String       @unique
  originHosts        String[]
  siteType           String
  hostingMode        String
  canonicalRules     Json
  allowedPublishPaths String[]
  ownershipVerifiedAt DateTime?
  active             Boolean      @default(true)
  brand              Brand        @relation(fields: [brandId], references: [id], onDelete: Restrict)
  markets            SiteMarket[]
  integrations       Integration[]
  analysisRuns        AnalysisRun[]
  recommendations     Recommendation[]
  opportunities       Opportunity[]
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt

  @@index([brandId, active])
}

model SiteMarket {
  id            String   @id @default(cuid())
  siteId        String
  country       String
  locale        String
  defaultDevice String   @default("desktop")
  timezone      String
  settings      Json?
  site          Site     @relation(fields: [siteId], references: [id], onDelete: Cascade)
  competitors   Competitor[]
  keywords      Keyword[]
  integrations  Integration[]
  analysisRuns  AnalysisRun[]
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([siteId, country, locale])
  @@index([siteId])
}

model Competitor {
  id           String      @id @default(cuid())
  brandId      String
  siteMarketId String?
  name         String
  aliases      String[]
  active       Boolean     @default(true)
  brand        Brand       @relation(fields: [brandId], references: [id], onDelete: Cascade)
  siteMarket   SiteMarket? @relation(fields: [siteMarketId], references: [id], onDelete: Cascade)
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt

  @@unique([brandId, siteMarketId, name])
  @@index([brandId, active])
}

model Keyword {
  id           String     @id @default(cuid())
  siteMarketId String
  text         String
  targetUrl    String?
  country      String
  device       String
  location     String     @default("*")
  priority     Int        @default(3)
  schedule     String
  active       Boolean    @default(true)
  siteMarket   SiteMarket @relation(fields: [siteMarketId], references: [id], onDelete: Cascade)
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt

  @@unique([siteMarketId, text, country, device, location])
  @@index([siteMarketId, active])
}
```

- [ ] **Step 3: Add integration, evidence, recommendation, and event models**

Add:

```prisma
model Integration {
  id           String   @id @default(cuid())
  siteId       String
  siteMarketId String?
  type         String
  endpoint     String?
  capabilities String[]
  adapterVersion String
  secretRef    String?
  healthState  String   @default("unknown")
  lastCheckedAt DateTime?
  site         Site     @relation(fields: [siteId], references: [id], onDelete: Cascade)
  siteMarket   SiteMarket? @relation(fields: [siteMarketId], references: [id], onDelete: Cascade)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([siteId, siteMarketId, type])
  @@index([siteId, healthState])
}

model AnalysisRun {
  id            String    @id
  clientId      String
  brandId       String
  siteId        String
  siteMarketId  String?
  kind          String
  source        String
  sourceVersion String
  adapterVersion String
  status        RunStatus
  inputHash     String
  idempotencyKey String    @unique
  trigger       String
  attemptCount  Int       @default(0)
  errorCode     String?
  errorSummary  String?
  startedAt     DateTime?
  finishedAt    DateTime?
  createdAt     DateTime  @default(now())
  artifacts     RawArtifact[]
  observations  Observation[]
  metrics       MetricSnapshot[]
  recommendations Recommendation[]
  client        Client    @relation(fields: [clientId], references: [id], onDelete: Restrict)
  brand         Brand     @relation(fields: [brandId], references: [id], onDelete: Restrict)
  site          Site      @relation(fields: [siteId], references: [id], onDelete: Restrict)
  siteMarket    SiteMarket? @relation(fields: [siteMarketId], references: [id], onDelete: Restrict)

  @@index([siteId, kind, inputHash])
  @@index([clientId, siteId, createdAt])
  @@index([status, createdAt])
}

model RawArtifact {
  id          String      @id @default(cuid())
  runId       String
  uri         String      @unique
  mediaType   String
  checksum    String
  byteSize    Int
  sourceVersion String
  retentionAt DateTime
  redacted    Boolean     @default(false)
  run         AnalysisRun @relation(fields: [runId], references: [id], onDelete: Restrict)
  createdAt   DateTime    @default(now())

  @@index([runId])
  @@index([retentionAt])
}

model Observation {
  id           String      @id @default(cuid())
  runId        String
  kind         String
  subject      String
  value        Json
  surface      String?
  provider     String?
  model        String?
  promptVersion Int?
  country      String?
  locale       String?
  observedAt   DateTime
  run          AnalysisRun @relation(fields: [runId], references: [id], onDelete: Restrict)
  recommendationEvidence RecommendationEvidence[]

  @@index([runId, kind])
  @@index([kind, observedAt])
}

model MetricSnapshot {
  id             String      @id @default(cuid())
  runId          String
  name           String
  value          Decimal     @db.Decimal(18, 6)
  dimensions     Json
  formulaVersion String
  calculatedAt   DateTime    @default(now())
  run            AnalysisRun @relation(fields: [runId], references: [id], onDelete: Restrict)

  @@index([runId, name])
}

model Recommendation {
  id              String      @id @default(cuid())
  runId           String
  clientId        String
  siteId          String
  title           String
  detail          String
  priority        Decimal     @db.Decimal(10, 4)
  formulaVersion  String
  state           String      @default("open")
  ownerId         String?
  dueAt           DateTime?
  resolution      String?
  verificationRunId String?
  run             AnalysisRun @relation(fields: [runId], references: [id], onDelete: Restrict)
  client          Client      @relation(fields: [clientId], references: [id], onDelete: Restrict)
  site            Site        @relation(fields: [siteId], references: [id], onDelete: Restrict)
  evidence        RecommendationEvidence[]
  opportunities   OpportunityRecommendation[]
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt

  @@index([clientId, siteId, state])
}

model RecommendationEvidence {
  recommendationId String
  observationId    String
  recommendation   Recommendation @relation(fields: [recommendationId], references: [id], onDelete: Cascade)
  observation      Observation    @relation(fields: [observationId], references: [id], onDelete: Restrict)

  @@id([recommendationId, observationId])
}

model Opportunity {
  id              String   @id @default(cuid())
  clientId        String
  siteId          String
  title           String
  state           String   @default("open")
  priority        Decimal  @db.Decimal(10, 4)
  formulaVersion  String
  client          Client   @relation(fields: [clientId], references: [id], onDelete: Restrict)
  site            Site     @relation(fields: [siteId], references: [id], onDelete: Restrict)
  recommendations OpportunityRecommendation[]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([clientId, siteId, state])
}

model OpportunityRecommendation {
  opportunityId    String
  recommendationId String
  opportunity      Opportunity    @relation(fields: [opportunityId], references: [id], onDelete: Cascade)
  recommendation   Recommendation @relation(fields: [recommendationId], references: [id], onDelete: Restrict)

  @@id([opportunityId, recommendationId])
}

model OutboxEvent {
  id            String   @id @default(cuid())
  aggregateType String
  aggregateId   String
  eventType     String
  payload       Json
  status        String   @default("pending")
  attemptCount  Int      @default(0)
  availableAt   DateTime @default(now())
  sentAt        DateTime?
  createdAt     DateTime @default(now())

  @@index([status, availableAt])
}

model InboxEvent {
  id          String   @id @default(cuid())
  source      String
  externalId  String
  eventType   String
  payloadHash String
  processedAt DateTime @default(now())

  @@unique([source, externalId])
}
```

Add nullable `clientId`, `brandId`, `siteId`, and `siteMarketId` fields to
legacy business rows in this expansion migration. Do not apply `NOT NULL` yet.

- [ ] **Step 4: Generate and validate the expansion migration**

Run:

```bash
npx prisma format
npx prisma validate
npx prisma migrate dev --name platform_foundation_expand --create-only
npx vitest run tests/integration/schema-contract.test.ts
```

Expected: schema validation and test pass; generated SQL only expands schema.

- [ ] **Step 5: Commit**

```bash
git add prisma tests/integration/schema-contract.test.ts
git commit -m "feat: add platform ownership and evidence schema"
```

### Task 4: Backfill Txpuro And Enforce Ownership

**Files:**
- Create: `prisma/migrations/20260731100000_backfill_txpuro_ownership/migration.sql`
- Create: `prisma/migrations/20260731110000_enforce_platform_scope/migration.sql`
- Create: `tests/integration/txpuro-backfill.test.ts`
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Write the failing backfill test**

Create a PostgreSQL integration test that seeds one row in every legacy table,
runs all migrations, and asserts:

```typescript
expect(await prisma.workspace.count()).toBe(1);
expect(await prisma.client.findUnique({ where: { id: "client_wing_heng" } })).not.toBeNull();
expect(await prisma.brand.findUnique({ where: { id: "brand_txpuro" } })).not.toBeNull();
expect(await prisma.site.findUnique({ where: { id: "site_txpuro_com" } })).toMatchObject({
  canonicalHost: "txpuro.com",
});
expect(await prisma.siteMarket.count({ where: { siteId: "site_txpuro_com" } })).toBe(2);
expect(await prisma.contentAsset.count({ where: { siteId: "site_txpuro_com" } }))
  .toBe(legacyAssetCount);
expect(afterUrls).toEqual(beforeUrls);
expect(orphanCounts).toEqual({
  contentAssets: 0,
  geoRuns: 0,
  exports: 0,
  dispatches: 0,
});
```

Run:

```bash
npm run test:integration -- tests/integration/txpuro-backfill.test.ts
```

Expected: FAIL because the backfill migrations do not exist.

- [ ] **Step 2: Write deterministic backfill SQL**

The backfill migration must:

```sql
INSERT INTO "Workspace" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('workspace_internal', 'Internal GEO SEO Operations', 'internal', NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Client" ("id", "workspaceId", "name", "slug", "active", "createdAt", "updatedAt")
VALUES ('client_wing_heng', 'workspace_internal', 'Wing Heng Technology', 'wing-heng', TRUE, NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Brand" (
  "id", "clientId", "name", "slug", "aliases", "riskCategory", "createdAt", "updatedAt"
) VALUES (
  'brand_txpuro', 'client_wing_heng', 'Txpuro', 'txpuro',
  ARRAY['Txpuro', '智慧电子发票系统 Txpuro'], 'standard', NOW(), NOW()
) ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Site" (
  "id", "brandId", "name", "canonicalHost", "originHosts", "siteType",
  "hostingMode", "canonicalRules", "allowedPublishPaths", "active", "createdAt", "updatedAt"
) VALUES (
  'site_txpuro_com', 'brand_txpuro', 'Txpuro', 'txpuro.com',
  ARRAY['geo-origin.winghengtech.com'], 'content', 'hybrid',
  '{"https":true,"www":"redirect"}'::jsonb, ARRAY['/guides'], TRUE, NOW(), NOW()
) ON CONFLICT ("id") DO NOTHING;
```

Insert `MY/zh-CN` and `MY/en` markets, then backfill every legacy table through
its existing relation chain. URL-only legacy rows must first join against the
normalized Txpuro host; unmatched rows abort migration with a raised
exception.

- [ ] **Step 3: Add constraint-enforcement SQL**

Before each `SET NOT NULL`, run an assertion:

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ContentAsset" WHERE "siteId" IS NULL) THEN
    RAISE EXCEPTION 'ContentAsset ownership backfill is incomplete';
  END IF;
END $$;

ALTER TABLE "ContentAsset"
  ALTER COLUMN "clientId" SET NOT NULL,
  ALTER COLUMN "brandId" SET NOT NULL,
  ALTER COLUMN "siteId" SET NOT NULL;
```

Add scoped indexes and foreign keys after all assertions pass.

- [ ] **Step 4: Run migration and URL-preservation tests**

Run:

```bash
npx prisma validate
npm run test:integration -- tests/integration/txpuro-backfill.test.ts
npm test -- src/lib/site-context.test.ts src/lib/txpuro.test.ts
```

Expected: PASS and every pre-migration public URL is byte-for-byte unchanged.

- [ ] **Step 5: Commit**

```bash
git add prisma tests/integration/txpuro-backfill.test.ts
git commit -m "feat: backfill Txpuro into platform ownership"
```

### Task 5: Add Better Auth And Application Roles

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/lib/auth.ts`
- Create: `src/lib/auth-client.ts`
- Create: `src/lib/authorization.ts`
- Create: `src/lib/authorization.test.ts`
- Create: `src/app/api/auth/[...all]/route.ts`
- Create: `src/app/login/page.tsx`
- Create: `src/app/(ops)/layout.tsx`
- Modify: `.env.example`

- [ ] **Step 1: Install Better Auth and write failing authorization tests**

Run:

```bash
npm install better-auth@1.6.25 @better-auth/prisma-adapter@1.6.25
npm install --save-dev tsx@4.23.1
```

Create `src/lib/authorization.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { assertClientAccess, requireRole, type AccessScope } from "./authorization";

const operator: AccessScope = {
  actorId: "user_1",
  workspaceId: "workspace_internal",
  role: "Operator",
  clientIds: ["client_a"],
};

describe("authorization", () => {
  it("allows an operator to use an owned client", () => {
    expect(assertClientAccess(operator, "client_a")).toBeUndefined();
  });

  it("rejects another client's data", () => {
    expect(() => assertClientAccess(operator, "client_b")).toThrow("CLIENT_FORBIDDEN");
  });

  it("requires reviewers for approval", () => {
    expect(() => requireRole(operator, ["Admin", "Reviewer"])).toThrow("ROLE_FORBIDDEN");
  });
});
```

Run:

```bash
npx vitest run src/lib/authorization.test.ts
```

Expected: FAIL because `authorization.ts` does not exist.

- [ ] **Step 2: Implement auth and authorization**

Create `src/lib/auth.ts`:

```typescript
import { betterAuth } from "better-auth/minimal";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getPrisma } from "@/lib/prisma";

export const auth = betterAuth({
  database: prismaAdapter(getPrisma(), { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: process.env.SGEO_ALLOW_BOOTSTRAP_SIGNUP !== "true",
    minPasswordLength: 12,
  },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
});
```

Create `src/lib/auth-client.ts`:

```typescript
"use client";
import { createAuthClient } from "better-auth/react";
export const authClient = createAuthClient();
```

Create `src/lib/authorization.ts`:

```typescript
import { auth } from "@/lib/auth";
import { getPrisma } from "@/lib/prisma";

export type AppRole = "Admin" | "Operator" | "Reviewer" | "Viewer";
export interface AccessScope {
  actorId: string;
  workspaceId: string;
  role: AppRole;
  clientIds: string[];
}

export class AuthorizationError extends Error {
  constructor(public code: "UNAUTHENTICATED" | "ROLE_FORBIDDEN" | "CLIENT_FORBIDDEN") {
    super(code);
  }
}

export function requireRole(scope: AccessScope, allowed: AppRole[]) {
  if (!allowed.includes(scope.role)) throw new AuthorizationError("ROLE_FORBIDDEN");
}

export function assertClientAccess(scope: AccessScope, clientId: string) {
  if (!scope.clientIds.includes(clientId)) throw new AuthorizationError("CLIENT_FORBIDDEN");
}

export async function requireAccessScope(request: Request): Promise<AccessScope> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new AuthorizationError("UNAUTHENTICATED");
  const membership = await getPrisma().workspaceMember.findFirstOrThrow({
    where: { userId: session.user.id },
    include: { workspace: { include: { clients: { select: { id: true } } } } },
  });
  return {
    actorId: session.user.id,
    workspaceId: membership.workspaceId,
    role: membership.role,
    clientIds: membership.workspace.clients.map(({ id }) => id),
  };
}
```

Create `src/app/api/auth/[...all]/route.ts`:

```typescript
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
export const { GET, POST } = toNextJsHandler(auth);
```

The login page calls:

```typescript
await authClient.signIn.email({ email, password, callbackURL: "/" });
```

and displays only email, password, submitting, and invalid-credentials states.
The `(ops)` layout enforces:

```typescript
const session = await auth.api.getSession({ headers: await headers() });
if (!session) redirect("/login");
```

- [ ] **Step 3: Add environment configuration and bootstrap the first user**

Add:

```dotenv
BETTER_AUTH_SECRET=""
BETTER_AUTH_URL="http://localhost:3000"
SGEO_ALLOW_BOOTSTRAP_SIGNUP="false"
```

Generate the deployment value with `openssl rand -base64 32` and write it to
the environment's secret store, never to `.env.example`.

Create `scripts/bootstrap-admin.ts`:

```typescript
process.env.SGEO_ALLOW_BOOTSTRAP_SIGNUP = "true";

const email = process.env.SGEO_BOOTSTRAP_ADMIN_EMAIL;
const name = process.env.SGEO_BOOTSTRAP_ADMIN_NAME;
const password = process.env.SGEO_BOOTSTRAP_ADMIN_PASSWORD;
if (!email || !name || !password) throw new Error("BOOTSTRAP_ENV_REQUIRED");

const [{ auth }, { getPrisma }] = await Promise.all([
  import("../src/lib/auth"),
  import("../src/lib/prisma"),
]);
const prisma = getPrisma();
if (await prisma.user.count() > 0) throw new Error("BOOTSTRAP_ALREADY_COMPLETED");

const created = await auth.api.signUpEmail({ body: { email, name, password } });
await prisma.$transaction(async (tx) => {
  const workspace = await tx.workspace.findUniqueOrThrow({
    where: { id: "workspace_internal" },
  });
  await tx.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: created.user.id, role: "Admin" },
  });
});
```

Add:

```json
{
  "scripts": {
    "auth:bootstrap": "tsx scripts/bootstrap-admin.ts"
  }
}
```

Run once after schema deployment:

```bash
SGEO_BOOTSTRAP_ADMIN_EMAIL="admin@example.com" \
SGEO_BOOTSTRAP_ADMIN_NAME="Platform Admin" \
SGEO_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
npm run auth:bootstrap
```

Never store `$ADMIN_PASSWORD` in Git or shell history.

- [ ] **Step 4: Run auth tests and commit**

Run:

```bash
npx vitest run src/lib/authorization.test.ts src/lib/basic-auth.test.ts
npm run typecheck
```

Historical plan expectation: PASS. Basic Auth remained active until Task 10.

```bash
git add package.json package-lock.json prisma src/lib/auth.ts \
  src/lib/auth-client.ts src/lib/authorization.ts \
  src/lib/authorization.test.ts src/app/api/auth src/app/login \
  'src/app/(ops)' scripts/bootstrap-admin.ts .env.example
git commit -m "feat: add internal session authentication and roles"
```

### Task 6: Add Signed Internal Service Authentication

**Files:**
- Create: `packages/internal-protocol/package.json`
- Create: `packages/internal-protocol/src/index.ts`
- Create: `packages/internal-protocol/src/index.test.ts`
- Create: `src/lib/internal-auth.ts`

- [ ] **Step 1: Write failing replay and signature tests**

Create `packages/internal-protocol/src/index.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { signInternalRequest, verifyInternalRequest } from "./index";

describe("internal request signatures", () => {
  it("accepts an unexpired matching body", async () => {
    const signed = await signInternalRequest("secret", "POST", "/ingest", "{}", 1_785_438_000);
    expect(await verifyInternalRequest("secret", signed, "POST", "/ingest", "{}", 1_785_438_030))
      .toBe(true);
  });

  it("rejects an expired signature", async () => {
    const signed = await signInternalRequest("secret", "POST", "/ingest", "{}", 1_785_438_000);
    expect(await verifyInternalRequest("secret", signed, "POST", "/ingest", "{}", 1_785_438_400))
      .toBe(false);
  });
});
```

Run:

```bash
npx vitest run packages/internal-protocol/src/index.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement HMAC authentication**

Use `crypto.createHmac("sha256", secret)` over:

```text
timestamp + "\n" + method + "\n" + pathname + "\n" + sha256(body)
```

Expose:

```typescript
export interface InternalSignature {
  timestamp: string;
  signature: string;
}

export function signInternalRequest(
  secret: string,
  method: string,
  pathname: string,
  body: string,
  nowSeconds?: number,
): Promise<InternalSignature>;

export function verifyInternalRequest(
  secret: string,
  signed: InternalSignature,
  method: string,
  pathname: string,
  body: string,
  nowSeconds?: number,
): Promise<boolean>;
```

Reject timestamps older than 300 seconds and compare signatures with
`timingSafeEqual`.

Create `packages/internal-protocol/package.json`:

```json
{
  "name": "@sgeo/internal-protocol",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts"
}
```

`src/lib/internal-auth.ts` re-exports the shared implementation:

```typescript
export {
  signInternalRequest,
  verifyInternalRequest,
  type InternalSignature,
} from "@sgeo/internal-protocol";
```

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run packages/internal-protocol/src/index.test.ts
npm run typecheck
git add packages/internal-protocol src/lib/internal-auth.ts package-lock.json
git commit -m "feat: authenticate internal service requests"
```

### Task 7: Implement Scoped Organization And Integration Repositories

**Files:**
- Create: `src/lib/organization/schemas.ts`
- Create: `src/lib/organization/scope.ts`
- Create: `src/lib/organization/repository.ts`
- Create: `src/lib/organization/repository.test.ts`
- Create: `src/lib/integrations/repository.ts`
- Create: `src/lib/integrations/secret-resolver.ts`
- Create: `src/lib/integrations/secret-resolver.test.ts`
- Create: organization and integration API routes listed in File Structure

- [ ] **Step 1: Write failing cross-client repository tests**

Use an injected Prisma-shaped fake and assert:

```typescript
await expect(repository.getSite(operatorScope, "site_client_b"))
  .rejects.toThrow("CLIENT_FORBIDDEN");
await expect(repository.createBrand(operatorScope, {
  clientId: "client_a",
  name: "Brand A",
  slug: "brand-a",
})).resolves.toMatchObject({ clientId: "client_a" });
```

Run:

```bash
npx vitest run src/lib/organization/repository.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement scoped repository methods**

The public interface is:

```typescript
export interface OrganizationRepository {
  listClients(scope: AccessScope): Promise<ClientSummary[]>;
  createClient(scope: AccessScope, input: CreateClientInput): Promise<ClientSummary>;
  createBrand(scope: AccessScope, input: CreateBrandInput): Promise<BrandSummary>;
  createSite(scope: AccessScope, input: CreateSiteInput): Promise<SiteSummary>;
  createSiteMarket(scope: AccessScope, input: CreateSiteMarketInput): Promise<SiteMarketSummary>;
  getSite(scope: AccessScope, siteId: string): Promise<SiteSummary>;
  resolveSiteByHost(host: string): Promise<ResolvedPublicSite | null>;
}
```

Every Prisma predicate starts at `workspaceId` or an allowed `clientId`; no
method accepts an unscoped `findUnique` result as authorization proof.

- [ ] **Step 3: Implement secret references**

`secret-resolver.ts` accepts only:

```typescript
export type SecretRef = `file:${string}`;
export interface SecretResolver {
  resolve(reference: SecretRef): Promise<string>;
}
```

Resolve beneath `SGEO_SECRET_ROOT` with `realpath`, reject traversal and
symlinks outside the root, trim one trailing newline, and never log the value.

- [ ] **Step 4: Add scoped API routes**

Each route follows:

```typescript
export async function POST(request: Request) {
  const scope = await requireAccessScope(request);
  requireRole(scope, ["Admin", "Operator"]);
  const parsed = createSiteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid site", issues: parsed.error.flatten() }, { status: 400 });
  }
  const site = await organizationRepository.createSite(scope, parsed.data);
  return NextResponse.json({ site }, { status: 201 });
}
```

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/organization src/lib/integrations
npm run typecheck
git add src/lib/organization src/lib/integrations src/app/api/clients \
  src/app/api/brands src/app/api/sites
git commit -m "feat: add scoped organization and integration APIs"
```

### Task 8: Add ArtifactStore, Analysis Repository, Outbox, And Inbox

**Files:**
- Create: `src/lib/artifacts/store.ts`
- Create: `src/lib/artifacts/local-store.ts`
- Create: `src/lib/artifacts/local-store.test.ts`
- Create: `src/lib/analysis/repository.ts`
- Create: `src/lib/events/outbox.ts`
- Create: `src/lib/events/inbox.ts`
- Create: `src/lib/events/events.test.ts`

- [ ] **Step 1: Write failing storage and event tests**

Test these behaviors:

```typescript
expect(await store.put("run_1", "report.json", bytes)).toMatchObject({
  uri: "artifact://run_1/report.json",
  checksum: expect.stringMatching(/^sha256:/),
  byteSize: bytes.byteLength,
});
expect(await store.get("artifact://run_1/report.json")).toEqual(bytes);
await expect(inbox.claim("geoflow", "event_1", "hash_1")).resolves.toBe(true);
await expect(inbox.claim("geoflow", "event_1", "hash_1")).resolves.toBe(false);
```

Run:

```bash
npx vitest run src/lib/artifacts src/lib/events
```

Expected: FAIL.

- [ ] **Step 2: Implement the storage interface**

```typescript
export interface StoredArtifact {
  uri: string;
  checksum: string;
  mediaType: string;
  byteSize: number;
}

export interface ArtifactStore {
  put(runId: string, name: string, body: Uint8Array, mediaType: string): Promise<StoredArtifact>;
  get(uri: string): Promise<Uint8Array>;
}
```

`LocalArtifactStore` writes to a temporary file beneath `SGEO_ARTIFACT_ROOT`,
calls `fsync`, renames atomically, and verifies the SHA-256 digest when read.

- [ ] **Step 3: Implement transaction-bound persistence**

Expose:

```typescript
export async function createRunWithOutbox(
  tx: Prisma.TransactionClient,
  run: CreateAnalysisRun,
  event: CreateOutboxEvent,
): Promise<void>;

export async function ingestEnvelope(
  tx: Prisma.TransactionClient,
  envelope: AnalysisEnvelope,
): Promise<void>;
```

`ingestEnvelope` validates ownership against the existing run, inserts
immutable artifacts and observations, and rejects a repeated run with a
different checksum.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/artifacts src/lib/events packages/analysis-contract
npm run typecheck
git add src/lib/artifacts src/lib/analysis src/lib/events
git commit -m "feat: add immutable artifacts and event delivery primitives"
```

### Task 9: Scope Legacy Business APIs And Make Audits Atomic

**Files:**
- Modify: `src/lib/audit-log.ts`
- Modify: `src/lib/content-assets.ts`
- Modify: every existing mutating route under `src/app/api/`
- Create: route tests beside each modified route

- [ ] **Step 1: Add one failing two-client route test per route family**

For content, GEO, trends, export packages, and GEOFlow routes:

```typescript
expect(await callRoute(asClientA, clientBEntityId)).toMatchObject({ status: 404 });
expect(await callRoute(asClientA, clientAEntityId)).toMatchObject({ status: 200 });
```

Run:

```bash
npx vitest run src/app/api
```

Expected: at least one cross-client assertion fails against each unscoped route
family.

- [ ] **Step 2: Replace direct access with scoped repositories**

Each route must call `requireAccessScope`, pass the scope to a repository, and
return `404` for entities outside the scope. Do not leak whether another
client's ID exists.

- [ ] **Step 3: Make business write, audit, and outbox atomic**

Replace best-effort post-write auditing with:

```typescript
await prisma.$transaction(async (tx) => {
  const entity = await repository.create(tx, scope, input);
  await createAuditEvent(tx, {
    actorId: scope.actorId,
    workspaceId: scope.workspaceId,
    clientId: entity.clientId,
    siteId: entity.siteId,
    action: "content_asset.create",
    entityType: "ContentAsset",
    entityId: entity.id,
    outcome: "success",
  });
  await createOutboxEvent(tx, {
    aggregateType: "ContentAsset",
    aggregateId: entity.id,
    eventType: "content_asset.created",
    payload: { contentAssetId: entity.id, siteId: entity.siteId },
  });
});
```

Required audits fail the transaction. Diagnostic failure logging remains
best-effort and must not include credentials or full content.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/app/api src/lib/audit-log.test.ts
npm run typecheck
git add src/app/api src/lib/audit-log.ts src/lib/content-assets.ts
git commit -m "fix: enforce client scope on business APIs"
```

### Task 10: Cut Over Authentication And Site Resolution

**Files:**
- Modify: `middleware.ts`
- Modify: `src/lib/site-context.ts`
- Modify: `src/lib/txpuro.ts`
- Modify: `src/lib/dashboard-snapshot.ts`
- Modify: `src/types/geo.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/components/geo-dashboard.tsx`
- Create: `src/app/(ops)/clients/page.tsx`
- Delete: `src/lib/basic-auth.ts`
- Delete: `src/lib/basic-auth.test.ts`

- [ ] **Step 1: Add failing host and authentication compatibility tests**

Prove:

```typescript
expect(resolvePublicRoute("txpuro.com", "/guides/pricing"))
  .toEqual({ siteId: "site_txpuro_com", locale: "zh-CN", slug: "pricing" });
expect(resolvePublicRoute("unknown.example", "/guides/pricing")).toBeNull();
expect(await requestOpsPage({ session: null })).toRedirectTo("/login");
expect(await requestPublicTxpuroPage({ session: null })).toHaveStatus(200);
```

- [ ] **Step 2: Replace Txpuro detection with site resolution**

`site-context.ts` exports:

```typescript
export async function resolvePublicSite(host: string): Promise<ResolvedPublicSite | null>;
export function publicContentPath(site: ResolvedPublicSite, slug: string, locale: string): string;
export function publicCanonicalUrl(site: ResolvedPublicSite, slug: string, locale: string): string;
```

Retain `isTxpuroHost`, `txpuroGuidesPath`, and `txpuroCanonicalUrl` as wrappers
until Phase 4, with tests proving unchanged output.

- [ ] **Step 3: Separate public host middleware from authenticated ops layout**

Historical Task 10 plan outcome: Middleware keeps request IDs, security headers, and public host routing. It no
longer parses Basic Auth. Session enforcement belongs in `(ops)/layout.tsx`
and every internal API handler.

- [ ] **Step 4: Replace the single project dashboard entry**

The root authenticated view lists clients and navigates to a selected site's
overview. Keep the existing dashboard at a compatibility route scoped to
Txpuro until Phase 2 replaces its reporting surface.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/site-context.test.ts src/lib/txpuro.test.ts src/app
npm run typecheck
npm run build
git add middleware.ts src
git commit -m "feat: cut over to session auth and database site context"
```

### Task 11: Remove Worker Database Access And Harden Deployment

**Files:**
- Modify: `geo-worker/package.json`
- Modify: `geo-worker/src/jobs/trend-crawl.ts`
- Delete: `geo-worker/prisma/schema.prisma`
- Modify: `docker-compose.yml`
- Modify: `deploy/docker-compose.prod.example.yml`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add a deployment policy test**

Create `tests/integration/compose-policy.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("service isolation", () => {
  it("does not give the worker the SGeoOps database URL", async () => {
    const compose = await readFile("docker-compose.yml", "utf8");
    const worker = compose.split("\n  geo-worker:")[1];
    expect(worker).not.toContain("DATABASE_URL=");
  });

  it("does not publish PostgreSQL or Redis ports in production", async () => {
    const compose = await readFile("deploy/docker-compose.prod.example.yml", "utf8");
    expect(compose).not.toMatch(/- ["']?5432:5432/);
    expect(compose).not.toMatch(/- ["']?6379:6379/);
  });
});
```

- [ ] **Step 2: Disable legacy direct-write jobs**

Until Phase 2 migrates Trigger.dev, `trend-crawl` and other direct-write jobs
must return a non-retryable migration error:

```typescript
throw new Error("LEGACY_WORKER_DISABLED_USE_SGEO_API");
```

Remove Prisma from the worker and give it only:

```dotenv
SGEO_INTERNAL_URL=http://geo-ops:3000
SGEO_INTERNAL_SECRET_FILE=/run/secrets/sgeo_internal_secret
```

- [ ] **Step 3: Harden Compose**

Use separate databases/credentials for SGeoOps and every selected service.
Do not expose PostgreSQL or Redis in production. Add persistent artifact and
secret mounts:

```yaml
volumes:
  - artifact-data:/var/lib/sgeo/artifacts
  - ./secrets:/run/secrets:ro
environment:
  - SGEO_ARTIFACT_ROOT=/var/lib/sgeo/artifacts
  - SGEO_SECRET_ROOT=/run/secrets
```

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tests/integration/compose-policy.test.ts
docker compose config --quiet
docker compose -f deploy/docker-compose.prod.example.yml config --quiet
npm run typecheck
git add geo-worker docker-compose.yml deploy .env.example README.md tests/integration
git commit -m "chore: isolate workers and production data services"
```

### Task 12: Phase 1 Acceptance

**Files:**
- Modify: `docs/system-reference.md`
- Modify: `docs/system-sop.md`

- [ ] **Step 1: Run the complete unit and integration suite**

```bash
npm test
npm run test:integration
npm run typecheck
npm run build
```

Expected: all commands exit `0`.

- [ ] **Step 2: Run the isolation and migration evidence checks**

```bash
npm run test:integration -- \
  tests/integration/client-isolation.test.ts \
  tests/integration/txpuro-backfill.test.ts \
  tests/integration/compose-policy.test.ts
```

Expected: two clients remain isolated, Txpuro URLs remain unchanged, and the
worker has no database credential.

- [ ] **Step 3: Document the operating procedures**

Document exact commands for:

```text
creating the first administrator
creating a client, brand, site, and market
registering a file-based secret reference
running migration expand/backfill/contract checks
restoring PostgreSQL and artifacts
rolling back the application without deleting new schema
```

- [ ] **Step 4: Commit**

```bash
git add docs/system-reference.md docs/system-sop.md
git commit -m "docs: record platform foundation operations"
```
