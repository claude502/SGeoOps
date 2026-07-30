# Phase 3 GEO Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace synthetic GEO runs with budget-controlled observations from official AI APIs through LiteLLM, with explicit surface separation and immutable provider evidence.

**Architecture:** SGeoOps owns prompts, schedules, budgets, runs, artifacts, observations, and metrics. Trigger.dev workers request prompts from SGeoOps and call a self-hosted LiteLLM gateway; provider-specific parsers preserve citations and metadata. API, consumer UI, and manual observations are never merged.

**Tech Stack:** LiteLLM core, Trigger.dev v4, OpenAI-compatible HTTP, Next.js, Prisma, Zod, Vitest, Docker Compose

---

## File Structure

Create:

```text
prisma/migrations/20260731130000_add_geo_monitoring/migration.sql
packages/geo-provider-adapter/package.json
packages/geo-provider-adapter/src/index.ts
packages/geo-provider-adapter/src/litellm-client.ts
packages/geo-provider-adapter/src/litellm-client.test.ts
packages/geo-provider-adapter/src/provider-parsers/openai.ts
packages/geo-provider-adapter/src/provider-parsers/gemini.ts
packages/geo-provider-adapter/src/provider-parsers/anthropic.ts
packages/geo-provider-adapter/src/provider-parsers/perplexity.ts
packages/geo-provider-adapter/src/normalize.ts
packages/geo-provider-adapter/src/normalize.test.ts
src/lib/geo-monitoring/metrics.ts
src/lib/geo-monitoring/metrics.test.ts
src/lib/geo-monitoring/budget.ts
src/lib/geo-monitoring/budget.test.ts
src/lib/geo-monitoring/repository.ts
src/lib/geo-monitoring/service.ts
src/app/api/site-markets/[siteMarketId]/geo/prompts/route.ts
src/app/api/site-markets/[siteMarketId]/geo/runs/route.ts
src/app/api/site-markets/[siteMarketId]/geo/metrics/route.ts
src/app/api/site-markets/[siteMarketId]/geo/coverage/route.ts
src/app/api/site-markets/[siteMarketId]/geo/manual-observations/route.ts
src/app/api/integrations/litellm/status/route.ts
geo-worker/src/tasks/geo-schedule-dispatch.ts
geo-worker/src/tasks/geo-basket-run.ts
geo-worker/src/tasks/geo-prompt-run.ts
test/fixtures/geo/{openai,gemini,anthropic,perplexity}/{success,success-with-citations,missing-citations,invalid,rate-limited,unauthorized,upstream-error}.json
tests/integration/geo-monitoring.test.ts
```

Modify:

```text
prisma/schema.prisma
geo-worker/package.json
geo-worker/trigger.config.ts
docker-compose.yml
deploy/docker-compose.prod.example.yml
.env.example
src/app/api/geo/audit/route.ts
src/app/api/geo/runs/route.ts
src/lib/geo-engine.ts
src/lib/geo-persistence.ts
src/types/geo.ts
```

### Task 1: Add Prompts, Provider Policies, And Budgets

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260731130000_add_geo_monitoring/migration.sql`
- Create: `src/lib/geo-monitoring/budget.test.ts`

- [ ] **Step 1: Write failing budget tests**

```typescript
expect(reserveBudget({ dailyLimit: 100, used: 90, requested: 10 })).toEqual({ allowed: true, remaining: 0 });
expect(reserveBudget({ dailyLimit: 100, used: 91, requested: 10 })).toEqual({ allowed: false, remaining: 9 });
```

- [ ] **Step 2: Add schema models**

Add:

```prisma
model Prompt {
  id             String     @id @default(cuid())
  siteMarketId   String
  text           String
  intent         String
  topic          String
  locale         String
  country        String
  providers      String[]
  searchEnabled  Boolean    @default(false)
  version        Int        @default(1)
  schedule       String
  active         Boolean    @default(true)
  createdAt      DateTime   @default(now())
  updatedAt      DateTime   @updatedAt
  siteMarket     SiteMarket @relation(fields: [siteMarketId], references: [id], onDelete: Cascade)

  @@index([siteMarketId, active])
}

model ProviderBudget {
  id             String   @id @default(cuid())
  clientId       String
  provider       String
  dailyRequestLimit Int
  dailyTokenLimit   Int?
  active         Boolean  @default(true)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  usages         ProviderUsage[]
  client         Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)

  @@unique([clientId, provider])
}

model ProviderUsage {
  id           String   @id @default(cuid())
  budgetId     String
  usageDate    DateTime @db.Date
  requestCount Int      @default(0)
  inputTokens  Int      @default(0)
  outputTokens Int      @default(0)
  costUsd      Decimal  @default(0) @db.Decimal(18, 6)
  updatedAt    DateTime @updatedAt
  budget       ProviderBudget @relation(fields: [budgetId], references: [id], onDelete: Cascade)

  @@unique([budgetId, usageDate])
}
```

Add `prompts Prompt[]` to `SiteMarket` and
`providerBudgets ProviderBudget[]` to `Client`.

Add optional `promptId`, `provider`, `model`, `surface`, `latencyMs`,
`inputTokens`, `outputTokens`, and `costUsd` fields to `AnalysisRun`.

- [ ] **Step 3: Implement transactional reservation**

`reserveProviderBudget(tx, clientId, provider, date, requested)` locks the
budget usage row with `SELECT ... FOR UPDATE`, checks request/token limits,
increments reservation counters, and returns a release token for failed calls.

- [ ] **Step 4: Verify and commit**

```bash
npx prisma validate
npx prisma migrate dev --name add_geo_monitoring --create-only
npx vitest run src/lib/geo-monitoring/budget.test.ts
git add prisma src/lib/geo-monitoring/budget*
git commit -m "feat: add GEO prompt and provider budget models"
```

### Task 2: Deploy LiteLLM Core And Implement Its Client

**Files:**
- Create: `packages/geo-provider-adapter/package.json`
- Create: `packages/geo-provider-adapter/src/index.ts`
- Create: `packages/geo-provider-adapter/src/litellm-client.ts`
- Create: `packages/geo-provider-adapter/src/litellm-client.test.ts`
- Modify: `geo-worker/package.json`
- Modify: `docker-compose.yml`
- Modify: `deploy/docker-compose.prod.example.yml`
- Modify: `.env.example`

- [ ] **Step 1: Write failing transport tests**

Cover success, timeout, `429`, `401`, `403`, and `5xx`:

```typescript
await expect(client.complete(request)).resolves.toMatchObject({
  provider: "openai",
  model: "gpt-5",
  latencyMs: expect.any(Number),
  raw: expect.any(Object),
});
await expect(rateLimitedClient.complete(request)).rejects.toMatchObject({
  code: "RATE_LIMITED",
  retryable: true,
});
```

- [ ] **Step 2: Implement the injected-fetch client**

Create `packages/geo-provider-adapter/package.json`:

```json
{
  "name": "@sgeo/geo-provider-adapter",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@sgeo/analysis-contract": "1.0.0"
  }
}
```

`packages/geo-provider-adapter/src/index.ts` exports the client, parser result
types, and normalizer. Add this exact workspace dependency to
`geo-worker/package.json`:

```json
{
  "dependencies": {
    "@sgeo/geo-provider-adapter": "1.0.0"
  }
}
```

```typescript
export interface GeoCompletionRequest {
  provider: "openai" | "gemini" | "anthropic" | "perplexity";
  model: string;
  prompt: string;
  locale: string;
  country: string;
  searchEnabled: boolean;
}

export interface GeoCompletionResponse {
  provider: string;
  model: string;
  raw: unknown;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
}
```

Use one configurable timeout, abort the fetch, and return safe errors without
provider keys or full prompt content.

- [ ] **Step 3: Add a pinned LiteLLM service**

Use LiteLLM core `1.94.0`, its signed pinned image, a private network, and a
read-only config mount. Provide provider keys through secret files. Expose
LiteLLM only to workers and the authenticated health route.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run packages/geo-provider-adapter/src/litellm-client.test.ts
docker compose config --quiet
npm run typecheck
git add packages/geo-provider-adapter geo-worker/package.json package-lock.json docker-compose.yml \
  deploy/docker-compose.prod.example.yml .env.example
git commit -m "feat: add self-hosted LiteLLM provider gateway"
```

### Task 3: Normalize Provider Responses

**Files:**
- Create: provider parser and normalization files under `packages/geo-provider-adapter/src/`
- Create: provider fixture files under `test/fixtures/geo/{openai,gemini,anthropic,perplexity}/`

- [ ] **Step 1: Add versioned fixtures**

For each provider add:

```text
success.json
success-with-citations.json
missing-citations.json
invalid.json
rate-limited.json
unauthorized.json
upstream-error.json
```

- [ ] **Step 2: Write failing parser tests**

Each success case must return:

```typescript
{
  answerText: expect.any(String),
  citedDomains: expect.any(Array),
  orderedEntities: expect.any(Array),
  providerMetadata: expect.any(Object),
}
```

The API observation must include `surface: "api"`, provider, model, country,
locale, prompt version, and observed time.

- [ ] **Step 3: Implement one parser per provider**

Expose a shared type:

```typescript
export interface ParsedProviderAnswer {
  answerText: string;
  citedUrls: string[];
  citedDomains: string[];
  orderedEntities: string[];
  providerMetadata: Record<string, unknown>;
}
```

Provider-specific shape handling stays in its own file. `normalize.ts` applies
brand aliases, canonical-domain matching, competitor aliases, and sentiment
classification without changing the raw artifact.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run packages/geo-provider-adapter/src/normalize.test.ts
npm run typecheck
git add packages/geo-provider-adapter test/fixtures/geo
git commit -m "feat: normalize official GEO provider responses"
```

### Task 4: Implement GEO Metrics

**Files:**
- Create: `src/lib/geo-monitoring/metrics.ts`
- Create: `src/lib/geo-monitoring/metrics.test.ts`

- [ ] **Step 1: Write failing formula tests**

```typescript
expect(mentionRate([true, false, true])).toBeCloseTo(2 / 3);
expect(citationRate([["a.com"], []])).toBe(0.5);
expect(canonicalCitationRate([["brand.com"], ["other.com"]], "brand.com")).toBe(0.5);
expect(GEO_FORMULA_VERSION).toBe("geo-v1");
```

- [ ] **Step 2: Implement segmented metrics**

Calculate brand mention rate, citation rate, canonical-domain citation rate,
mean ordered answer position, citation share of voice, competitor mention
share, sentiment distribution, source-domain coverage, prompt coverage, and
provider coverage.

Every metric key includes:

```typescript
{
  provider: string;
  model: string;
  surface: "api" | "consumer_ui" | "manual";
  country: string;
  locale: string;
  promptVersion: number;
  dateRange: { from: string; to: string };
}
```

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run src/lib/geo-monitoring/metrics.test.ts
npm run typecheck
git add src/lib/geo-monitoring/metrics*
git commit -m "feat: calculate versioned GEO visibility metrics"
```

### Task 5: Implement The GEO Run Service And Worker Tasks

**Files:**
- Create: `src/lib/geo-monitoring/repository.ts`
- Create: `src/lib/geo-monitoring/service.ts`
- Create: `geo-worker/src/tasks/geo-schedule-dispatch.ts`
- Create: `geo-worker/src/tasks/geo-basket-run.ts`
- Create: `geo-worker/src/tasks/geo-prompt-run.ts`

- [ ] **Step 1: Write failing partial-provider tests**

Given OpenAI success, Gemini `429`, Anthropic timeout, and Perplexity success:

```typescript
expect(result.status).toBe("partial");
expect(result.successfulProviders).toEqual(["openai", "perplexity"]);
expect(result.failedProviders).toEqual(["gemini", "anthropic"]);
expect(result.observations).not.toContainEqual(expect.objectContaining({ synthetic: true }));
```

- [ ] **Step 2: Implement run lifecycle**

`GeoMonitoringService` creates one basket run and child provider runs, reserves
budget, stores raw response artifacts before parsing, appends observations,
calculates metrics, and marks coverage gaps. Provider failure never writes a
synthetic answer.

- [ ] **Step 3: Add schedules**

`geo-schedule-dispatch` finds due prompt baskets through signed SGeoOps API.
`geo-basket-run` fans out provider calls with per-client and per-provider
concurrency. `geo-prompt-run` calls LiteLLM and ingests one envelope.

Default:

```typescript
queue: { name: "geo-provider", concurrencyLimit: 4 },
maxDuration: 300
```

Provider-specific queues impose lower limits when configured.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/geo-monitoring
npm --workspace geo-worker test -- src/tasks/geo
npm run typecheck
npm --workspace geo-worker run typecheck
git add src/lib/geo-monitoring geo-worker/src/tasks/geo-*
git commit -m "feat: run budgeted multi-provider GEO baskets"
```

### Task 6: Add Scoped Prompt, Run, Metric, And Coverage APIs

**Files:**
- Create: GEO route files listed in File Structure
- Create: route tests beside each route
- Modify: `src/app/api/geo/audit/route.ts`
- Modify: `src/app/api/geo/runs/route.ts`

- [ ] **Step 1: Write failing isolation and validation tests**

Test Client A cannot list or mutate Client B prompts/runs. Reject an API
observation without model, provider, country, locale, and prompt version.

- [ ] **Step 2: Implement scoped routes**

Prompt writes require `Admin` or `Operator`. Report reads permit all four
roles. Routes accept explicit date ranges and never merge observation
surfaces.

- [ ] **Step 3: Convert legacy routes**

Legacy `/api/geo/audit` may produce preview/demo results only:

```typescript
{
  mode: "simulation",
  excludedFromProductionMetrics: true
}
```

`/api/geo/runs` becomes a scoped compatibility projection over new
observations. A configured API key must no longer cause synthetic output to be
labelled `provider`.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/app/api/geo src/app/api/site-markets
npm run typecheck
git add src/app/api/geo src/app/api/site-markets \
  src/lib/geo-engine.ts src/lib/geo-persistence.ts src/types/geo.ts
git commit -m "fix: replace simulated production GEO reporting"
```

### Task 7: Add Manual Consumer-Surface Imports

**Files:**
- Create: `src/app/api/site-markets/[siteMarketId]/geo/manual-observations/route.ts`
- Create: route test beside it

- [ ] **Step 1: Write failing surface tests**

```typescript
expect(apiImport.surface).toBe("api");
expect(manualConsumerImport.surface).toBe("consumer_ui");
expect(report.series.api).not.toEqual(report.series.consumer_ui);
```

- [ ] **Step 2: Implement reviewed import**

Only `Admin`, `Operator`, and `Reviewer` may import. Require provider,
consumer product, prompt text/version, country, locale, observed timestamp,
answer evidence, and collector identity. Store uploaded evidence through
ArtifactStore.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run \
  src/app/api/site-markets/[siteMarketId]/geo/manual-observations/route.test.ts
npm run typecheck
git add src/app/api/site-markets
git commit -m "feat: import separated consumer GEO observations"
```

### Task 8: Phase 3 Reporting And Acceptance

**Files:**
- Create: `src/app/(ops)/sites/[siteId]/geo/page.tsx`
- Create: `src/components/geo/provider-coverage.tsx`
- Create: `src/components/geo/visibility-table.tsx`
- Create: `tests/integration/geo-monitoring.test.ts`

- [ ] **Step 1: Build the scoped GEO report**

Display provider/model/surface selectors, coverage gaps, mention/citation
metrics, competitor share, prompt rows, and run history. Surface is a required
filter and never defaults to a merged view.

- [ ] **Step 2: Run a four-provider fixture integration**

```bash
npm run test:integration -- tests/integration/geo-monitoring.test.ts
```

Expected: two successful providers and two failed providers create a `partial`
run, preserve four coverage statuses, and create no synthetic observations.

- [ ] **Step 3: Run the phase gate**

```bash
npm test
npm run test:integration
npm --workspace geo-worker test
npm --workspace geo-worker run typecheck
npm run typecheck
npm run build
docker compose config --quiet
```

Expected: all commands exit `0`.

- [ ] **Step 4: Commit**

```bash
git add 'src/app/(ops)/sites' src/components/geo \
  tests/integration/geo-monitoring.test.ts
git commit -m "feat: add real GEO monitoring workspace"
```
