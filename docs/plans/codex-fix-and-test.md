# GEO Ops — Fix & Test Sprint

You are an expert TypeScript / Next.js engineer. Execute the tasks below in order,
one at a time. After each task run the relevant tests before moving on.
Do NOT skip steps.

---

## ⚠️ Context (must read first)

**Repo:** geo-ops (Next.js 15 + Prisma + Bun worker)
**Branch:** main
**What Codex already built:** GEO+SEO dual scorer, viral templates, trend leverage,
content packaging API, geo-worker (Trigger.dev cron jobs).

**What's still broken / missing:**
1. `content-generate` job is a stub — never creates actual content
2. No geo-worker startup guard when `TRIGGER_API_KEY` is empty
3. `GET /api/content/packages` has no error handling around DB calls
4. `trend-leverage` blacklist needs broader coverage + tests
5. `PATCH /api/trends/[id]/status` emits event but has no test verifying it

**Key existing files you will reuse:**
- `src/lib/viral/trend-leverage.ts` — `isSafeKeyword()`, `buildLeveragePrompt()`
- `src/lib/viral/templates.ts` — `VIRAL_TEMPLATES`, `getTemplate()`, `buildTemplatePrompt()`
- `src/lib/seo/dual-optimizer.ts` — `scoreDualContent()`
- `src/lib/geo-engine.ts` — `generateChannelVariants()`
- `src/lib/geo-persistence.ts` — `saveChannelVariants()`
- `src/lib/prisma.ts` — `db` (Prisma singleton)

**Types:** `src/types/geo.ts` has `ChannelPlatform`, `GeoProject`, `Provider`.
`ChannelPlatform` values: `"Knowledge Site" | "LinkedIn" | "X" | "WeChat" | "Xiaohongshu"`.

---

## Task 1 — Internal content-generate API endpoint

### Goal
Create a Next.js API route that the geo-worker calls after a trend is approved.
It runs safety checks, builds content from viral templates + leverage prompts,
scores it, saves a `ContentAsset` to Postgres, and generates `ChannelVariant`s.

### Files to create
- `src/app/api/internal/content-generate/route.ts`
- `src/app/api/internal/content-generate/route.test.ts`

---

### Step 1 — Write failing tests first

`src/app/api/internal/content-generate/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma before any imports that pull it in
vi.mock("@/lib/prisma", () => ({
  db: {
    trendTopic: {
      findUnique: vi.fn(),
    },
    contentAsset: {
      create: vi.fn(),
    },
  },
  isDatabaseConfigured: vi.fn().mockReturnValue(true),
}));

// saveChannelVariants writes to DB — stub it
vi.mock("@/lib/geo-persistence", () => ({
  saveChannelVariants: vi.fn().mockResolvedValue([]),
}));

import { POST } from "./route";
import { db } from "@/lib/prisma";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/internal/content-generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/content-generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when body is missing required fields", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when keyword is unsafe (blacklisted)", async () => {
    const res = await POST(
      makeRequest({ topicId: "t1", keyword: "政变 新闻", platform: "weibo" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("unsafe");
  });

  it("returns 404 when TrendTopic not found", async () => {
    vi.mocked(db.trendTopic.findUnique).mockResolvedValue(null);
    const res = await POST(
      makeRequest({ topicId: "missing", keyword: "电子发票新规", platform: "weibo" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 201 with contentAssetId when everything succeeds", async () => {
    vi.mocked(db.trendTopic.findUnique).mockResolvedValue({
      id: "t1",
      keyword: "马来西亚电子发票",
      platform: "google",
      score: 80,
      region: "MY",
      sourceType: "crawler",
      status: "approved",
      capturedAt: new Date(),
      expiresAt: null,
      createdAt: new Date(),
    } as never);

    vi.mocked(db.contentAsset.create).mockResolvedValue({
      id: "asset_1",
      title: "Test",
    } as never);

    const res = await POST(
      makeRequest({ topicId: "t1", keyword: "马来西亚电子发票", platform: "weibo" }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.contentAssetId).toBe("asset_1");
    expect(typeof body.variantCount).toBe("number");
  });
});
```

Run — expect FAIL (module not found):
```bash
npm test -- src/app/api/internal/content-generate/route.test.ts
```

---

### Step 2 — Implement the route

`src/app/api/internal/content-generate/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";

import { db } from "@/lib/prisma";
import { isSafeKeyword, buildLeveragePrompt } from "@/lib/viral/trend-leverage";
import { VIRAL_TEMPLATES, buildTemplatePrompt } from "@/lib/viral/templates";
import { scoreDualContent } from "@/lib/seo/dual-optimizer";
import { generateChannelVariants } from "@/lib/geo-engine";
import { saveChannelVariants } from "@/lib/geo-persistence";
import type { GeoProject, Provider } from "@/types/geo";

const schema = z.object({
  topicId: z.string().min(1),
  keyword: z.string().min(1).max(200),
  platform: z.string().min(1),
});

/** The Txpuro brand context used for all generated content. */
function getTxpuroProject(): GeoProject {
  return {
    id: "txpuro",
    name: "Txpuro",
    brand: process.env.GEO_BRAND ?? "Txpuro",
    product: process.env.GEO_PRODUCT ?? "e-Invoice",
    locale: "zh-CN",
    competitors: ["Bukku", "AutoCount", "SQL Account"],
    targetKeywords: ["Malaysia e-Invoice", "电子发票", "LHDN e-Invoice", "电子发票系统"],
    canonicalDomain: process.env.GEO_CANONICAL_DOMAIN ?? "txpuro.com",
  };
}

/**
 * Pick the best viral template for a given platform.
 * Falls back to "contrast-reveal" for unknown platforms.
 */
function pickTemplate(platform: string) {
  const norm = platform.toLowerCase();
  return (
    VIRAL_TEMPLATES.find((t) => t.platforms.some((p) => norm.includes(p))) ??
    VIRAL_TEMPLATES[0]!
  );
}

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { topicId, keyword, platform } = parsed.data;

  // Safety gate — block blacklisted keywords before any DB work
  if (!isSafeKeyword(keyword)) {
    return NextResponse.json(
      { error: `Keyword is unsafe and cannot be used for content generation: "${keyword}"` },
      { status: 400 },
    );
  }

  const trend = await db.trendTopic.findUnique({ where: { id: topicId } });
  if (!trend) {
    return NextResponse.json({ error: "TrendTopic not found" }, { status: 404 });
  }

  const project = getTxpuroProject();
  const template = pickTemplate(platform);

  // Build content body from leverage angles + template structure
  const leverageBlock = buildLeveragePrompt({
    keyword,
    productName: project.brand,
    brand: project.brand,
    platform,
  });

  const templateBlock = buildTemplatePrompt(template, {
    productName: project.brand,
    keyword,
    platform,
  });

  const title = `${keyword} — ${project.brand} ${project.product}指南`;
  const body = `${leverageBlock}\n\n---\n\n${templateBlock}`;
  const summary = `基于热搜「${keyword}」，介绍 ${project.brand} ${project.product}的核心价值与借势角度。`;

  // Score GEO + SEO quality
  const scored = scoreDualContent({
    title,
    body,
    targetKeywords: project.targetKeywords,
    project,
    prompt: keyword,
    provider: "ChatGPT" as Provider,
  });

  // Persist ContentAsset
  const assetId = `asset_trend_${nanoid(10)}`;
  const asset = await db.contentAsset.create({
    data: {
      id: assetId,
      title,
      body,
      summary,
      brandEntity: project.brand,
      sourceUrl: `https://${project.canonicalDomain}/`,
      targetKeywords: project.targetKeywords,
      canonicalUrl: `https://${project.canonicalDomain}/trend/${trend.id}`,
      status: "Draft",
      geoScore: scored.geoScore,
      seoScore: scored.seoScore,
      owner: "geo-worker",
      sourceSystem: "trend_engine",
      locale: "zh-CN",
      assetType: "guide-page",
      trendTopicId: topicId,
    },
  });

  // Generate + save channel variants
  const variants = generateChannelVariants({
    asset: { id: asset.id, title, summary, body, brandEntity: project.brand },
    platforms: ["Knowledge Site", "LinkedIn", "WeChat", "Xiaohongshu"],
  });

  await saveChannelVariants(variants);

  return NextResponse.json(
    { contentAssetId: asset.id, variantCount: variants.length, geoScore: scored.geoScore, seoScore: scored.seoScore },
    { status: 201 },
  );
}
```

---

### Step 3 — Install nanoid if not present

Check `package.json` — if `nanoid` is not listed, add it:
```bash
npm install nanoid
```
(Skip if already in dependencies.)

---

### Step 4 — Run tests, confirm green

```bash
npm test -- src/app/api/internal/content-generate/route.test.ts
# Expected: 4 tests passed
```

---

### Step 5 — Wire geo-worker to call the new endpoint

Replace `geo-worker/src/jobs/content-generate.ts`:

```typescript
import { eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

import { client } from "../trigger";

const GENERATE_URL =
  process.env.GEO_OPS_INTERNAL_URL ?? "http://localhost:3000";

client.defineJob({
  id: "content-generate",
  name: "内容生成（话题审批后）",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "trend.approved",
    schema: z.object({
      topicId: z.string(),
      keyword: z.string(),
      platform: z.string(),
    }),
  }),
  run: async (payload, io) => {
    const event = payload as { topicId: string; keyword: string; platform: string };
    await io.logger.info("Calling content-generate API", { topicId: event.topicId });

    const res = await fetch(`${GENERATE_URL}/api/internal/content-generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      throw new Error(`content-generate API returned ${res.status}: ${text}`);
    }

    const result = await res.json();
    await io.logger.info("Content generated", result);
    return result;
  },
});
```

Add `GEO_OPS_INTERNAL_URL` to `geo-worker` section in `docker-compose.yml`:
```yaml
      - GEO_OPS_INTERNAL_URL=http://geo-ops:3000
```

---

### Step 6 — Commit Task 1

```bash
git add src/app/api/internal/ geo-worker/src/jobs/content-generate.ts docker-compose.yml
git commit -m "feat: implement content-generate API + wire geo-worker job"
```

---

## Task 2 — geo-worker startup validation

### Goal
Log a clear warning on startup if `TRIGGER_API_KEY` is missing, so the operator
knows the worker is in degraded mode (jobs won't register with Trigger.dev).

### File to modify
`geo-worker/src/index.ts`

---

### Step 1 — Update index.ts

Replace the entire `geo-worker/src/index.ts`:

```typescript
import "./jobs/trend-crawl";
import "./jobs/content-generate";
import "./jobs/seo-audit";

const REQUIRED_ENV: Record<string, string | undefined> = {
  DATABASE_URL: process.env.DATABASE_URL,
  TRIGGER_API_URL: process.env.TRIGGER_API_URL,
  TRIGGER_API_KEY: process.env.TRIGGER_API_KEY,
  TRIGGER_PROJECT_REF: process.env.TRIGGER_PROJECT_REF,
};

const missing = Object.entries(REQUIRED_ENV)
  .filter(([, v]) => !v?.trim())
  .map(([k]) => k);

if (missing.length > 0) {
  console.warn(
    `[geo-worker] ⚠️  Missing env vars: ${missing.join(", ")}. ` +
      "Jobs are registered but Trigger.dev connection may fail.",
  );
} else {
  console.log("[geo-worker] ✅ All env vars present. 3 jobs registered.");
}
```

---

### Step 2 — Commit Task 2

```bash
git add geo-worker/src/index.ts
git commit -m "fix: add geo-worker startup env validation"
```

---

## Task 3 — Broader safety filter tests + PATCH event emission test

### Goal
Strengthen the keyword safety tests and add a test confirming that
`PATCH /api/trends/[id]/status` fires a fetch when a topic is approved.

### Files to modify / create
- `src/lib/viral/trend-leverage.test.ts` — extend existing describe blocks
- `src/app/api/trends/[id]/status/route.test.ts` — new file

---

### Step 1 — Extend trend-leverage.test.ts

Open `src/lib/viral/trend-leverage.test.ts` and ADD these cases inside the
existing `describe("isSafeKeyword")` block (after the existing tests):

```typescript
  it("blocks all blacklisted terms", () => {
    const blocked = ["暴动现场", "恐袭警告", "群体事件爆发", "选举舞弊证据", "种族冲突"];
    for (const kw of blocked) {
      expect(isSafeKeyword(kw)).toBe(false);
    }
  });

  it("passes common business / finance keywords", () => {
    const safe = [
      "LHDN e-Invoice deadline 2025",
      "中小企业税务合规",
      "电子发票系统对比",
      "Malaysia SME accounting software",
      "ERP integration guide",
    ];
    for (const kw of safe) {
      expect(isSafeKeyword(kw)).toBe(true);
    }
  });

  it("is case-insensitive for mixed-script input", () => {
    // English chars surrounding a blacklisted Chinese term
    expect(isSafeKeyword("latest 政变 news")).toBe(false);
  });
```

Run to confirm new tests pass:
```bash
npm test -- src/lib/viral/trend-leverage.test.ts
```

---

### Step 2 — Write PATCH route test

`src/app/api/trends/[id]/status/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch before importing the route
const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
vi.stubGlobal("fetch", mockFetch);

vi.mock("@/lib/prisma", () => ({
  db: {
    trendTopic: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { PATCH } from "./route";
import { db } from "@/lib/prisma";

const MOCK_TOPIC = {
  id: "topic_1",
  keyword: "马来西亚电子发票",
  platform: "google",
  score: 80,
  region: "MY",
  sourceType: "crawler",
  status: "pending",
  capturedAt: new Date(),
  expiresAt: null,
  createdAt: new Date(),
};

function makeRequest(id: string, body: unknown) {
  return new Request(`http://localhost/api/trends/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/trends/[id]/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TRIGGER_API_URL = "http://trigger:3040";
    process.env.TRIGGER_WORKER_API_KEY = "test-key";
    process.env.TRIGGER_PROJECT_REF = "proj_test";
  });

  it("returns 400 for invalid status value", async () => {
    const res = await PATCH(makeRequest("t1", { status: "active" }), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when topic does not exist", async () => {
    vi.mocked(db.trendTopic.findUnique).mockResolvedValue(null);
    const res = await PATCH(makeRequest("missing", { status: "approved" }), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("updates status to rejected and does NOT emit event", async () => {
    vi.mocked(db.trendTopic.findUnique).mockResolvedValue(MOCK_TOPIC as never);
    vi.mocked(db.trendTopic.update).mockResolvedValue({
      ...MOCK_TOPIC,
      status: "rejected",
    } as never);

    const res = await PATCH(makeRequest("topic_1", { status: "rejected" }), {
      params: Promise.resolve({ id: "topic_1" }),
    });
    expect(res.status).toBe(200);
    // fetch must NOT be called for rejections
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("updates status to approved and fires trend.approved event", async () => {
    vi.mocked(db.trendTopic.findUnique).mockResolvedValue(MOCK_TOPIC as never);
    vi.mocked(db.trendTopic.update).mockResolvedValue({
      ...MOCK_TOPIC,
      status: "approved",
    } as never);

    const res = await PATCH(makeRequest("topic_1", { status: "approved" }), {
      params: Promise.resolve({ id: "topic_1" }),
    });
    expect(res.status).toBe(200);

    // Give the fire-and-forget void promise a tick to execute
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/events");
    const payload = JSON.parse(options.body as string);
    expect(payload.name).toBe("trend.approved");
    expect(payload.payload.topicId).toBe("topic_1");
    expect(payload.payload.keyword).toBe("马来西亚电子发票");
  });
});
```

---

### Step 3 — Run all tests

```bash
npm test -- src/lib/viral/trend-leverage.test.ts src/app/api/trends
# Expected: all tests pass
```

---

### Step 4 — Run the full test suite

```bash
npm test
# Expected: ALL tests pass (no regressions)
```

---

### Step 5 — Commit Task 3

```bash
git add src/lib/viral/trend-leverage.test.ts "src/app/api/trends/[id]/status/route.test.ts"
git commit -m "test: extend safety filter coverage + verify trend approval event emission"
```

---

## Task 4 — Error handling for packages list endpoint

### Goal
`GET /api/content/packages` currently crashes with a 500 if the DB is down.
Wrap the query in try/catch and return a graceful error.

### File to modify
`src/app/api/content/packages/route.ts`

---

### Step 1 — Wrap the DB call

Modify the route so the `db.contentAsset.findMany` call is wrapped:

```typescript
export async function GET(request: Request) {
  // ... (keep existing limit/cursor parsing unchanged) ...

  let assets;
  try {
    assets = await db.contentAsset.findMany({ /* ...unchanged... */ });
  } catch (err) {
    console.error("[/api/content/packages] DB error:", err);
    return NextResponse.json(
      { error: "Failed to load content packages. Please try again." },
      { status: 503 },
    );
  }

  // ... (keep existing hasMore / nextCursor logic unchanged) ...
}
```

Keep everything else in the route identical — only add the try/catch around
`db.contentAsset.findMany`.

---

### Step 2 — Commit Task 4

```bash
git add src/app/api/content/packages/route.ts
git commit -m "fix: graceful 503 when DB unavailable in packages list endpoint"
```

---

## End-to-end validation checklist

After all commits, confirm:

```bash
# 1. Full test suite — all green
npm test
# Expected: 17+ tests passed, 0 failed

# 2. TypeScript — no new errors
npx tsc --noEmit
# Expected: no output (clean)

# 3. Check commit log
git log --oneline -5
# Expected: 4 new commits on top of 7f85aca
```

---

## Out of scope (do NOT implement)

- Auth on trend write endpoints (follow-up sprint, tracked in review doc)
- Pinning docker-compose trigger-dev image version (ops task, not code)
- GSC / Ahrefs data integration (next milestone)
- Lighthouse CI seo-audit job (needs Chromium environment)
