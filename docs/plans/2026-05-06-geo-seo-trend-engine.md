# GEO+SEO 双引擎 + 热搜爆款 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有 GEO Ops 基础上增加 SEO 双轨优化、多平台热搜监控、爆款模板内容工厂、内容打包 API，以及独立的 geo-worker 异步任务服务。

**Architecture:** geo-ops（现有 Next.js）扩展 SEO Engine + Content Factory + 打包 API；新增 geo-worker（Bun + Trigger.dev）处理热搜抓取、内容生成、SEO 巡检；两个服务共享 PostgreSQL + Redis。

**Tech Stack:** Next.js 15, Prisma, PostgreSQL, Redis, Bun, Trigger.dev (self-hosted), Firecrawl, google-trends-api, Lighthouse CI, Vitest, Zod

---

## ⚠️ 现有模型对齐（必读）

- `ChannelVariant` — 平台变体模型（= 设计中的 ContentVariant，已存在）
- `ContentAsset.geoScore` — 已存在（Int）
- `ContentAsset.variants` — 已关联 ChannelVariant[]
- `scoreGeoContent()` in `src/lib/geo-engine.ts` — 已有 GEO 评分器，SEO 评分器对齐此签名

---

## Task 1: 基础设施 — Redis + Trigger.dev

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`

**Step 1: 新增 Redis + Trigger.dev 到 docker-compose**

在 `services:` 下添加：

```yaml
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data
    ports:
      - "6379:6379"

  trigger-dev:
    image: ghcr.io/triggerdotdev/trigger.dev:latest
    restart: unless-stopped
    depends_on: [postgres, redis]
    ports:
      - "3040:3000"
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=redis://redis:6379
      - SECRET_KEY=${TRIGGER_SECRET_KEY}
      - LOGIN_ORIGIN=http://localhost:3040
      - APP_ORIGIN=http://localhost:3040

volumes:
  redis-data:
```

**Step 2: 新增环境变量到 .env.example**

```bash
REDIS_URL=redis://localhost:6379
TRIGGER_SECRET_KEY=changeme
TRIGGER_API_URL=http://localhost:3040
TRIGGER_PROJECT_REF=proj_geo_ops
FIRECRAWL_API_KEY=
GSC_SERVICE_ACCOUNT_JSON=
AHREFS_API_KEY=
```

**Step 3: 启动验证**

```bash
docker-compose up redis trigger-dev -d
sleep 30
curl http://localhost:3040/healthcheck
# 预期：200
```

**Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "infra: add Redis and Trigger.dev to docker-compose"
```

---

## Task 2: 数据模型 Migration

**Files:**
- Modify: `prisma/schema.prisma`

**Step 1: 在 `ChannelVariant` 模型中添加 metrics 关联**

```prisma
// 在 ChannelVariant 末尾添加
  metrics    VariantMetric[]
```

**Step 2: 在 `ContentAsset` 模型中添加新字段**

```prisma
// 在 ContentAsset 末尾添加（geoScore 已存在，只加新的）
  seoScore      Int?
  trendTopicId  String?
  templateId    String?
  trendTopic    TrendTopic? @relation(fields: [trendTopicId], references: [id])
```

**Step 3: 在 schema.prisma 末尾追加新模型**

```prisma
model TrendTopic {
  id         String         @id @default(cuid())
  keyword    String
  platform   String
  score      Int
  region     String         @default("CN")
  sourceType String
  status     String         @default("pending")
  capturedAt DateTime
  expiresAt  DateTime?
  createdAt  DateTime       @default(now())
  assets     ContentAsset[]

  @@index([status])
  @@index([platform])
  @@index([capturedAt])
}

model VariantMetric {
  id               String         @id @default(cuid())
  channelVariantId String
  channelVariant   ChannelVariant @relation(fields: [channelVariantId], references: [id], onDelete: Cascade)
  impressions      Int            @default(0)
  clicks           Int            @default(0)
  shares           Int            @default(0)
  recordedAt       DateTime

  @@index([channelVariantId])
  @@index([recordedAt])
}

model SeoAudit {
  id        String   @id @default(cuid())
  url       String
  score     Int
  issues    Json
  cwv       Json?
  auditedAt DateTime

  @@index([url])
  @@index([auditedAt])
}

model KeywordRanking {
  id          String   @id @default(cuid())
  keyword     String
  url         String
  position    Int
  clicks      Int      @default(0)
  impressions Int      @default(0)
  source      String
  recordedAt  DateTime

  @@index([keyword])
  @@index([url])
  @@index([recordedAt])
}
```

**Step 4: 运行 migration**

```bash
npm run prisma:migrate
# 输入名称：add_seo_trend_engine
# 预期：Migration applied successfully
npm run prisma:generate
```

**Step 5: Commit**

```bash
git add prisma/
git commit -m "feat: add TrendTopic, VariantMetric, SeoAudit, KeywordRanking models"
```

---

## Task 3: SEO 双轨优化器

**Files:**
- Create: `src/lib/seo/dual-optimizer.ts`
- Create: `src/lib/seo/dual-optimizer.test.ts`

**Step 1: 写失败测试**

`src/lib/seo/dual-optimizer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { scoreSeoContent, scoreDualContent } from "./dual-optimizer";

describe("scoreSeoContent", () => {
  it("returns higher score when keyword appears in title and body", () => {
    const result = scoreSeoContent({
      title: "Malaysia e-Invoice System Guide",
      body: "The Malaysia e-Invoice system helps SMEs comply with LHDN requirements. This system is essential.",
      targetKeywords: ["Malaysia e-Invoice system"],
      locale: "en",
    });
    expect(result.score).toBeGreaterThan(50);
    expect(result.keywordDensity).toBeGreaterThan(0);
    expect(result.titleHasKeyword).toBe(true);
  });

  it("returns 0 density when no keywords present", () => {
    const result = scoreSeoContent({
      title: "Hello World",
      body: "Some unrelated content here.",
      targetKeywords: ["Malaysia e-Invoice system"],
      locale: "en",
    });
    expect(result.keywordDensity).toBe(0);
  });
});

describe("scoreDualContent", () => {
  it("returns both geoScore and seoScore between 0 and 100", () => {
    const result = scoreDualContent({
      title: "Txpuro Malaysia e-Invoice",
      body: "Txpuro is a Malaysia e-Invoice system for SMEs.",
      targetKeywords: ["Malaysia e-Invoice"],
      project: {
        id: "test",
        name: "Txpuro",
        brand: "Txpuro",
        product: "e-Invoice",
        locale: "en",
        competitors: [],
        targetKeywords: ["Malaysia e-Invoice"],
        canonicalDomain: "txpuro.com",
      },
      prompt: "best Malaysia e-Invoice system",
      provider: "ChatGPT",
    });
    expect(result.geoScore).toBeGreaterThanOrEqual(0);
    expect(result.seoScore).toBeGreaterThanOrEqual(0);
    expect(result.geoScore).toBeLessThanOrEqual(100);
    expect(result.seoScore).toBeLessThanOrEqual(100);
  });
});
```

**Step 2: 跑测试确认失败**

```bash
npm test -- src/lib/seo/dual-optimizer.test.ts
# 预期：FAIL — cannot find module
```

**Step 3: 实现 dual-optimizer.ts**

`src/lib/seo/dual-optimizer.ts`:

```typescript
import type { GeoProject, Provider } from "@/types/geo";
import { scoreGeoContent } from "@/lib/geo-engine";

interface SeoScoreInput {
  title: string;
  body: string;
  targetKeywords: string[];
  locale: string;
}

export interface SeoScoreResult {
  score: number;
  keywordDensity: number;
  titleHasKeyword: boolean;
  suggestions: string[];
}

interface DualScoreInput {
  title: string;
  body: string;
  targetKeywords: string[];
  project: GeoProject;
  prompt: string;
  provider: Provider;
}

export interface DualScoreResult {
  geoScore: number;
  seoScore: number;
  suggestions: string[];
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countOccurrences(text: string, needle: string): number {
  if (!needle.trim()) return 0;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text.match(new RegExp(escaped, "gi")) ?? []).length;
}

export function scoreSeoContent(input: SeoScoreInput): SeoScoreResult {
  const fullText = `${input.title} ${input.body}`;
  const words = wordCount(fullText);
  const suggestions: string[] = [];
  const primaryKeyword = input.targetKeywords[0] ?? "";

  const keywordOccurrences = countOccurrences(fullText, primaryKeyword);
  const keywordDensity = words > 0 ? (keywordOccurrences / words) * 100 : 0;
  const titleHasKeyword = primaryKeyword
    ? input.title.toLowerCase().includes(primaryKeyword.toLowerCase())
    : false;

  if (!titleHasKeyword && primaryKeyword) {
    suggestions.push(`Add "${primaryKeyword}" to the title`);
  }
  if (keywordDensity < 0.5 && primaryKeyword) {
    suggestions.push(`Increase keyword density (current: ${keywordDensity.toFixed(2)}%)`);
  }
  if (words < 300) {
    suggestions.push("Aim for 300+ words for better SEO coverage");
  }

  let score = 30;
  if (titleHasKeyword) score += 25;
  if (keywordDensity >= 0.5 && keywordDensity <= 3) score += 20;
  if (words >= 300) score += 15;
  const secondaryHits = input.targetKeywords
    .slice(1)
    .filter((kw) => fullText.toLowerCase().includes(kw.toLowerCase())).length;
  score += secondaryHits * 5;

  return {
    score: Math.min(100, score),
    keywordDensity,
    titleHasKeyword,
    suggestions,
  };
}

export function scoreDualContent(input: DualScoreInput): DualScoreResult {
  const geoResult = scoreGeoContent({
    text: `${input.title}\n${input.body}`,
    project: input.project,
    prompt: input.prompt,
    provider: input.provider,
  });

  const seoResult = scoreSeoContent({
    title: input.title,
    body: input.body,
    targetKeywords: input.targetKeywords,
    locale: input.project.locale,
  });

  return {
    geoScore: geoResult.score,
    seoScore: seoResult.score,
    suggestions: [...seoResult.suggestions],
  };
}
```

**Step 4: 跑测试确认通过**

```bash
npm test -- src/lib/seo/dual-optimizer.test.ts
# 预期：PASS — 3 tests passed
```

**Step 5: Commit**

```bash
git add src/lib/seo/
git commit -m "feat: add SEO dual-track scorer alongside existing GEO engine"
```

---

## Task 4: 爆款模板库

**Files:**
- Create: `src/lib/viral/templates.ts`
- Create: `src/lib/viral/templates.test.ts`

**Step 1: 写失败测试**

`src/lib/viral/templates.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getTemplate, VIRAL_TEMPLATES, buildTemplatePrompt } from "./templates";

describe("getTemplate", () => {
  it("returns template by id", () => {
    const t = getTemplate("contrast-reveal");
    expect(t).toBeDefined();
    expect(t?.id).toBe("contrast-reveal");
  });

  it("returns undefined for unknown id", () => {
    expect(getTemplate("nonexistent")).toBeUndefined();
  });
});

describe("buildTemplatePrompt", () => {
  it("includes product name, keyword, and hook", () => {
    const template = getTemplate("contrast-reveal")!;
    const prompt = buildTemplatePrompt(template, {
      productName: "Txpuro",
      keyword: "Malaysia e-Invoice",
      platform: "xiaohongshu",
    });
    expect(prompt).toContain("Txpuro");
    expect(prompt).toContain("Malaysia e-Invoice");
    expect(prompt).toContain(template.hook);
  });
});

describe("VIRAL_TEMPLATES", () => {
  it("has at least 3 templates", () => {
    expect(VIRAL_TEMPLATES.length).toBeGreaterThanOrEqual(3);
  });

  it("each template has required fields", () => {
    for (const t of VIRAL_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.hook).toBeTruthy();
      expect(t.platforms.length).toBeGreaterThan(0);
    }
  });
});
```

**Step 2: 跑测试确认失败**

```bash
npm test -- src/lib/viral/templates.test.ts
# 预期：FAIL
```

**Step 3: 实现 templates.ts**

`src/lib/viral/templates.ts`:

```typescript
export type ViralPlatform =
  | "xiaohongshu" | "weibo" | "linkedin" | "reddit"
  | "zhihu" | "tiktok" | "x" | "instagram";

export type ViralFormat = "short" | "long" | "thread" | "video_script";

export type ViralTemplate = {
  id: string;
  name: string;
  platforms: ViralPlatform[];
  format: ViralFormat;
  hook: string;
  structure: string[];
  cta: string;
};

export const VIRAL_TEMPLATES: ViralTemplate[] = [
  {
    id: "contrast-reveal",
    name: "对比揭秘",
    platforms: ["xiaohongshu", "weibo", "linkedin"],
    format: "short",
    hook: "以'99%的人不知道…'或'我以为X，结果发现Y'开头，制造认知落差",
    structure: [
      "痛点场景（2句话，读者能立刻认出自己）",
      "反直觉结论（1句，出乎意料）",
      "原因拆解（3点，每点一句）",
      "产品切入（自然带出，非硬广，1-2句）",
    ],
    cta: "以问题结尾引发评论，例如'你们遇到过这个问题吗？'",
  },
  {
    id: "listicle-authority",
    name: "权威列举",
    platforms: ["linkedin", "reddit", "zhihu"],
    format: "long",
    hook: "数字开头：'做了X件事之后，我终于搞清楚了…'，建立权威感",
    structure: [
      "背景铺垫（问题严重性，2-3句）",
      "N个核心点（每点：加粗标题 + 2句解释）",
      "总结归纳（1句提炼）",
    ],
    cta: "呼吁收藏或转发：'收藏备用，下次选型时用得上'",
  },
  {
    id: "story-arc",
    name: "故事弧",
    platforms: ["xiaohongshu", "tiktok", "instagram"],
    format: "short",
    hook: "第一句是结局，制造悬念：'我差点因为这件事损失XX万'",
    structure: [
      "现状（困境，读者能代入）",
      "转折点（发现了什么）",
      "解决过程（简短，不要细节堆砌）",
      "结果 + 产品自然露出",
    ],
    cta: "情感共鸣收尾：'希望这个经历能帮到你们'",
  },
  {
    id: "question-answer",
    name: "问答式",
    platforms: ["zhihu", "reddit", "x"],
    format: "thread",
    hook: "以高频搜索问题开头，直接作为标题或第一行",
    structure: [
      "直接回答（BLUF: 第一段给答案）",
      "展开解释（分点，每点有依据）",
      "补充场景（什么情况下例外）",
    ],
    cta: "邀请追问：'还有其他问题欢迎评论'",
  },
];

export function getTemplate(id: string): ViralTemplate | undefined {
  return VIRAL_TEMPLATES.find((t) => t.id === id);
}

export function buildTemplatePrompt(
  template: ViralTemplate,
  context: { productName: string; keyword: string; platform: string }
): string {
  return `
你是一位在 ${context.platform} 上写爆款内容的创作者。

产品：${context.productName}
话题关键词：${context.keyword}
内容模板：${template.name}

开头要求：${template.hook}

内容结构（按顺序展开）：
${template.structure.map((s, i) => `${i + 1}. ${s}`).join("\n")}

结尾要求：${template.cta}

约束：
- 内容必须与"${context.keyword}"有实质关联，不能牵强
- 产品（${context.productName}）自然带出，不能是硬广
- 不得强行拉踩竞品
`.trim();
}
```

**Step 4: 跑测试确认通过**

```bash
npm test -- src/lib/viral/templates.test.ts
# 预期：PASS — 5 tests passed
```

**Step 5: Commit**

```bash
git add src/lib/viral/
git commit -m "feat: add viral template library with 4 templates"
```

---

## Task 5: 热搜借势 Prompt 构建器

**Files:**
- Create: `src/lib/viral/trend-leverage.ts`
- Create: `src/lib/viral/trend-leverage.test.ts`

**Step 1: 写失败测试**

`src/lib/viral/trend-leverage.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildLeveragePrompt, isSafeKeyword } from "./trend-leverage";

describe("isSafeKeyword", () => {
  it("passes clean business keywords", () => {
    expect(isSafeKeyword("Malaysia e-Invoice system")).toBe(true);
    expect(isSafeKeyword("电子发票 中小企业")).toBe(true);
  });

  it("blocks blacklisted keywords", () => {
    expect(isSafeKeyword("政变示例词")).toBe(false);
  });
});

describe("buildLeveragePrompt", () => {
  it("includes keyword, product name, and angle count", () => {
    const prompt = buildLeveragePrompt({
      keyword: "LHDN e-Invoice deadline",
      productName: "Txpuro",
      brand: "Txpuro",
      platform: "linkedin",
    });
    expect(prompt).toContain("LHDN e-Invoice deadline");
    expect(prompt).toContain("Txpuro");
    expect(prompt).toContain("3个借势角度");
  });
});
```

**Step 2: 跑测试确认失败**

```bash
npm test -- src/lib/viral/trend-leverage.test.ts
# 预期：FAIL
```

**Step 3: 实现 trend-leverage.ts**

`src/lib/viral/trend-leverage.ts`:

```typescript
const KEYWORD_BLACKLIST = [
  "政变", "暴动", "恐袭", "群体事件", "政治", "选举舞弊", "种族冲突",
];

export function isSafeKeyword(keyword: string): boolean {
  const lower = keyword.toLowerCase();
  return !KEYWORD_BLACKLIST.some((blocked) =>
    lower.includes(blocked.toLowerCase())
  );
}

interface LeveragePromptInput {
  keyword: string;
  productName: string;
  brand: string;
  platform: string;
  audience?: string;
}

export function buildLeveragePrompt(input: LeveragePromptInput): string {
  return `
热搜话题：${input.keyword}
目标平台：${input.platform}
产品：${input.productName}（品牌：${input.brand}）
目标受众：${input.audience ?? "中小企业主、财务负责人"}

任务：生成3个借势角度。每个角度包含：
1. 一句话说明如何将热点话题与产品自然关联
2. 核心传播钩子（一句话）
3. 适合的细分受众

约束：
- 关联必须自然，避免硬广感
- 不得强行拉踩竞品
- 与"${input.keyword}"有实质关联

输出格式：
角度1：[关联] | 钩子：[一句话] | 受众：[描述]
角度2：[关联] | 钩子：[一句话] | 受众：[描述]
角度3：[关联] | 钩子：[一句话] | 受众：[描述]
`.trim();
}
```

**Step 4: 跑测试确认通过**

```bash
npm test -- src/lib/viral/trend-leverage.test.ts
# 预期：PASS
```

**Step 5: Commit**

```bash
git add src/lib/viral/trend-leverage.ts src/lib/viral/trend-leverage.test.ts
git commit -m "feat: add trend leverage prompt builder with keyword safety filter"
```

---

## Task 6: 内容打包 API

**Files:**
- Create: `src/app/api/content/packages/route.ts`
- Create: `src/app/api/content/packages/[id]/route.ts`
- Create: `src/app/api/content/variants/[id]/metrics/route.ts`
- Create: `src/app/api/trends/manual/route.ts`
- Create: `src/app/api/trends/[id]/status/route.ts`

**Step 1: 内容包列表 GET**

`src/app/api/content/packages/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform") ?? undefined;
  const cursor = searchParams.get("cursor") ?? undefined;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 100);

  const assets = await db.contentAsset.findMany({
    where: {
      isPublic: true,
      status: "Ready",
      ...(platform ? { variants: { some: { platform } } } : {}),
    },
    include: {
      variants: {
        where: platform ? { platform } : undefined,
        include: { metrics: { orderBy: { recordedAt: "desc" }, take: 1 } },
      },
      trendTopic: { select: { keyword: true, platform: true, score: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = assets.length > limit;
  const items = hasMore ? assets.slice(0, limit) : assets;
  const nextCursor = hasMore ? items.at(-1)?.id ?? null : null;

  return NextResponse.json({ items, nextCursor, hasMore });
}
```

**Step 2: 单包详情 GET**

`src/app/api/content/packages/[id]/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const asset = await db.contentAsset.findUnique({
    where: { id: params.id },
    include: {
      variants: { include: { metrics: { orderBy: { recordedAt: "desc" }, take: 5 } } },
      trendTopic: true,
    },
  });

  if (!asset) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const platforms = Object.fromEntries(
    asset.variants.map((v) => [
      v.platform,
      { copy: v.copy, mediaAssets: v.mediaAssets, latestMetrics: v.metrics[0] ?? null },
    ])
  );

  return NextResponse.json({
    id: asset.id,
    title: asset.title,
    summary: asset.summary,
    geoScore: asset.geoScore,
    seoScore: asset.seoScore,
    trendTopic: asset.trendTopic,
    platforms,
  });
}
```

**Step 3: A/B 数据回传 POST**

`src/app/api/content/variants/[id]/metrics/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { z } from "zod";

const Schema = z.object({
  impressions: z.number().int().min(0),
  clicks: z.number().int().min(0),
  shares: z.number().int().min(0),
  recordedAt: z.string().datetime().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const parsed = Schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const variant = await db.channelVariant.findUnique({ where: { id: params.id } });
  if (!variant) {
    return NextResponse.json({ error: "Variant not found" }, { status: 404 });
  }

  const metric = await db.variantMetric.create({
    data: {
      channelVariantId: params.id,
      ...parsed.data,
      recordedAt: parsed.data.recordedAt ? new Date(parsed.data.recordedAt) : new Date(),
    },
  });

  return NextResponse.json(metric, { status: 201 });
}
```

**Step 4: 手动录入热搜 POST**

`src/app/api/trends/manual/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { z } from "zod";

const Schema = z.object({
  keyword: z.string().min(1).max(200),
  platform: z.enum(["weibo", "google", "tiktok", "xiaohongshu", "linkedin", "reddit", "x", "manual"]),
  score: z.number().int().min(0).max(100).default(50),
  region: z.enum(["CN", "MY", "SG", "GLOBAL"]).default("CN"),
  expiresAt: z.string().datetime().optional(),
});

export async function POST(request: Request) {
  const parsed = Schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const topic = await db.trendTopic.create({
    data: {
      ...parsed.data,
      sourceType: "manual",
      capturedAt: new Date(),
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    },
  });

  return NextResponse.json(topic, { status: 201 });
}
```

**Step 5: 话题审批 PATCH**

`src/app/api/trends/[id]/status/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { z } from "zod";

const Schema = z.object({ status: z.enum(["approved", "rejected"]) });

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const parsed = Schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const topic = await db.trendTopic.update({
    where: { id: params.id },
    data: { status: parsed.data.status },
  });

  return NextResponse.json(topic);
}
```

**Step 6: 验证 API**

```bash
npm run dev &
sleep 5

# 录入热搜
curl -s -X POST http://localhost:3000/api/trends/manual \
  -H "Content-Type: application/json" \
  -d '{"keyword":"马来西亚电子发票新规","platform":"manual","score":80,"region":"MY"}' | python3 -m json.tool

# 拉取内容包
curl -s http://localhost:3000/api/content/packages | python3 -m json.tool
```

**Step 7: Commit**

```bash
git add src/app/api/content/ src/app/api/trends/
git commit -m "feat: add content packaging API and trend management endpoints"
```

---

## Task 7: geo-worker 骨架（Bun + Trigger.dev）

**Files:**
- Create: `geo-worker/package.json`
- Create: `geo-worker/src/trigger.ts`
- Create: `geo-worker/src/jobs/trend-crawl.ts`
- Create: `geo-worker/src/jobs/content-generate.ts`
- Create: `geo-worker/src/jobs/seo-audit.ts`
- Create: `geo-worker/Dockerfile`

**Step 1: 初始化项目**

```bash
mkdir -p geo-worker/src/jobs geo-worker/src/clients
cd geo-worker
bun init -y
bun add @trigger.dev/sdk @prisma/client zod
bun add -d typescript @types/node
```

**Step 2: Trigger.dev 客户端 `geo-worker/src/trigger.ts`**

```typescript
import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: process.env.TRIGGER_PROJECT_REF ?? "proj_geo_ops",
  apiKey: process.env.TRIGGER_API_KEY ?? "",
  apiUrl: process.env.TRIGGER_API_URL ?? "http://localhost:3040",
});
```

**Step 3: 热搜抓取 job `geo-worker/src/jobs/trend-crawl.ts`**

```typescript
import { cronTrigger } from "@trigger.dev/sdk";
import { client } from "../trigger";

client.defineJob({
  id: "trend-crawl",
  name: "热搜抓取（每15分钟）",
  version: "1.0.0",
  trigger: cronTrigger({ cron: "*/15 * * * *" }),
  run: async (_payload, io) => {
    await io.logger.info("Trend crawl started");
    // TODO Task 8: 接入 Google Trends + Firecrawl
    return { crawled: 0 };
  },
});
```

**Step 4: 内容生成 job `geo-worker/src/jobs/content-generate.ts`**

```typescript
import { eventTrigger } from "@trigger.dev/sdk";
import { client } from "../trigger";
import { z } from "zod";

client.defineJob({
  id: "content-generate",
  name: "内容生成（话题审批后）",
  version: "1.0.0",
  trigger: eventTrigger({
    name: "trend.approved",
    schema: z.object({ topicId: z.string(), keyword: z.string(), platform: z.string() }),
  }),
  run: async (payload, io) => {
    await io.logger.info("Generating content", { topicId: payload.topicId });
    // TODO Task 9: dual-optimizer + templates
    return { topicId: payload.topicId, status: "generated" };
  },
});
```

**Step 5: SEO 巡检 job `geo-worker/src/jobs/seo-audit.ts`**

```typescript
import { cronTrigger } from "@trigger.dev/sdk";
import { client } from "../trigger";

client.defineJob({
  id: "seo-audit",
  name: "技术 SEO 巡检（每日凌晨3点）",
  version: "1.0.0",
  trigger: cronTrigger({ cron: "0 3 * * *" }),
  run: async (_payload, io) => {
    await io.logger.info("SEO audit started");
    // TODO Task 10: Lighthouse CI
    return { audited: 0 };
  },
});
```

**Step 6: `geo-worker/Dockerfile`**

```dockerfile
FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY src ./src
CMD ["bun", "run", "src/trigger.ts"]
```

**Step 7: 加入 docker-compose.yml**

```yaml
  geo-worker:
    build: ./geo-worker
    restart: unless-stopped
    depends_on: [postgres, redis, trigger-dev]
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - TRIGGER_API_URL=http://trigger-dev:3000
      - TRIGGER_API_KEY=${TRIGGER_WORKER_API_KEY}
      - TRIGGER_PROJECT_REF=proj_geo_ops
```

**Step 8: 验证**

```bash
cd geo-worker
bun run src/trigger.ts
# 预期：Connected to Trigger.dev，3 jobs registered
```

**Step 9: Commit**

```bash
git add geo-worker/ docker-compose.yml
git commit -m "feat: add geo-worker skeleton with Trigger.dev cron and event jobs"
```

---

## Task 8: 热搜抓取实现

**Files:**
- Create: `geo-worker/src/clients/google-trends.ts`
- Create: `geo-worker/src/clients/firecrawl.ts`
- Modify: `geo-worker/src/jobs/trend-crawl.ts`

**Step 1: 安装依赖**

```bash
cd geo-worker
bun add google-trends-api @mendable/firecrawl-js
```

**Step 2: `geo-worker/src/clients/google-trends.ts`**

```typescript
// @ts-expect-error — no type defs
import googleTrends from "google-trends-api";

export interface TrendResult {
  keyword: string;
  score: number;
  platform: "google";
  region: string;
}

export async function fetchGoogleTrends(geo = "MY"): Promise<TrendResult[]> {
  try {
    const raw = await googleTrends.dailyTrends({ geo });
    const data = JSON.parse(raw);
    const items = data?.default?.trendingSearchesDays?.[0]?.trendingSearches ?? [];
    return items.slice(0, 20).map(
      (item: { title: { query: string } }, i: number) => ({
        keyword: item.title.query,
        score: Math.max(0, 100 - i * 5),
        platform: "google" as const,
        region: geo,
      })
    );
  } catch {
    return [];
  }
}
```

**Step 3: `geo-worker/src/clients/firecrawl.ts`**

```typescript
import FirecrawlApp from "@mendable/firecrawl-js";

const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY ?? "" });

export interface WeiboTrendResult {
  keyword: string;
  score: number;
  platform: "weibo";
  region: "CN";
}

export async function fetchWeiboTrending(): Promise<WeiboTrendResult[]> {
  try {
    const result = await firecrawl.scrapeUrl("https://s.weibo.com/top/summary", {
      formats: ["extract"],
      extract: {
        schema: {
          type: "object",
          properties: {
            trends: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rank: { type: "number" },
                  keyword: { type: "string" },
                },
              },
            },
          },
        },
      },
    });

    const trends = (result.extract as { trends?: { rank: number; keyword: string }[] })?.trends ?? [];
    return trends.slice(0, 20).map((t) => ({
      keyword: t.keyword,
      score: Math.max(0, 100 - (t.rank - 1) * 5),
      platform: "weibo" as const,
      region: "CN" as const,
    }));
  } catch {
    return [];
  }
}
```

**Step 4: 更新 trend-crawl job（替换 TODO）**

```typescript
import { cronTrigger } from "@trigger.dev/sdk";
import { client } from "../trigger";
import { fetchGoogleTrends } from "../clients/google-trends";
import { fetchWeiboTrending } from "../clients/firecrawl";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

client.defineJob({
  id: "trend-crawl",
  name: "热搜抓取（每15分钟）",
  version: "1.0.0",
  trigger: cronTrigger({ cron: "*/15 * * * *" }),
  run: async (_payload, io) => {
    const [google, weibo] = await Promise.allSettled([
      fetchGoogleTrends("MY"),
      fetchWeiboTrending(),
    ]);

    const all = [
      ...(google.status === "fulfilled" ? google.value : []),
      ...(weibo.status === "fulfilled" ? weibo.value : []),
    ];

    if (all.length > 0) {
      await db.trendTopic.createMany({
        data: all.map((r) => ({
          keyword: r.keyword,
          platform: r.platform,
          score: r.score,
          region: "region" in r ? String(r.region) : "CN",
          sourceType: "crawler",
          capturedAt: new Date(),
          status: "pending",
        })),
      });
    }

    await io.logger.info("Trend crawl complete", { count: all.length });
    return { crawled: all.length };
  },
});
```

**Step 5: 手动验证**

```bash
cd geo-worker
node -e "require('./src/clients/google-trends').fetchGoogleTrends('MY').then(r => console.log(r.slice(0,3)))"
# 预期：3条马来西亚热搜
```

**Step 6: Commit**

```bash
git add geo-worker/src/clients/ geo-worker/src/jobs/trend-crawl.ts
git commit -m "feat: implement trend crawling via Google Trends and Firecrawl"
```

---

## 端到端验证清单

```bash
# 基础设施
curl http://localhost:3040/healthcheck                         # ✓ Trigger.dev running

# 数据库
npx prisma studio                                              # ✓ 5 new tables visible

# 手动录入热搜
curl -X POST http://localhost:3000/api/trends/manual \
  -H "Content-Type: application/json" \
  -d '{"keyword":"马来西亚电子发票","platform":"manual","score":80,"region":"MY"}'
# ✓ 201 + TrendTopic JSON

# 审批话题
curl -X PATCH http://localhost:3000/api/trends/<id>/status \
  -H "Content-Type: application/json" \
  -d '{"status":"approved"}'
# ✓ 200

# 内容包列表
curl http://localhost:3000/api/content/packages
# ✓ 200 + { items, hasMore }

# A/B 数据回传
curl -X POST http://localhost:3000/api/content/variants/<variantId>/metrics \
  -H "Content-Type: application/json" \
  -d '{"impressions":1000,"clicks":50,"shares":10}'
# ✓ 201 + VariantMetric JSON

# 单元测试全通过
npm test
# ✓ All tests passed
```

---

## 后续迭代（本次范围外）

- GSC / Ahrefs 数据回流（填充 KeywordRanking）
- Dashboard UI：热搜话题审批界面 + A/B 可视化
- content-generate job 完整实现（接入 dual-optimizer + templates）
- Lighthouse CI SEO 巡检（Task 9，需要 Chromium 环境）
- 平台安全过滤黑名单完善
