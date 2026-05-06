你是一名高级全栈工程师，正在扩展一个 Next.js 15 + Prisma + PostgreSQL 项目。

项目路径就是你当前的工作目录。请逐步完成以下8个任务，每个任务完成后立即 commit。不要一次性做完再提交。

---

## 重要背景

**现有文件（不要修改其已有逻辑，只扩展）：**
- `src/lib/geo-engine.ts` — 已导出 `scoreGeoContent()` 函数，新代码要 import 复用它
- `src/lib/prisma.ts` — 已导出 `db`（Prisma Client 单例），所有 DB 操作用它
- `prisma/schema.prisma` — 已有 `ContentAsset`、`ChannelVariant` 等模型
- `src/types/geo.ts` — 已有 `GeoProject`、`Provider` 类型

**现有 `ContentAsset` 已有字段：** `geoScore`（Int）、`variants`（ChannelVariant[]）
**现有 `ChannelVariant`** 就是平台内容变体模型，不要新建重复的模型

**命令参考：**
- 测试：`npm test -- <文件路径>`
- Migration：`npm run prisma:migrate`
- 类型检查：`npm run typecheck`
- 所有新文件用 TypeScript，API 路由用 Zod 校验输入，测试用 Vitest

---

## TASK 1：扩展 Prisma Schema

**修改 `prisma/schema.prisma`：**

第一步，在 `ChannelVariant` 模型最后一个字段后、`@@index` 前，加一行：
```
  metrics    VariantMetric[]
```

第二步，在 `ContentAsset` 模型最后一个字段后、`@@index` 前，加：
```
  seoScore      Int?
  trendTopicId  String?
  templateId    String?
  trendTopic    TrendTopic? @relation(fields: [trendTopicId], references: [id])
```

第三步，在文件末尾追加这4个新模型：

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

然后运行：
```bash
npm run prisma:migrate
# 当提示输入 migration 名称时输入：add_seo_trend_engine
npm run prisma:generate
```

然后 commit：
```bash
git add prisma/
git commit -m "feat: add TrendTopic, VariantMetric, SeoAudit, KeywordRanking models"
```

---

## TASK 2：SEO 双轨优化器

先创建测试文件 `src/lib/seo/dual-optimizer.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { scoreSeoContent, scoreDualContent } from "./dual-optimizer";

describe("scoreSeoContent", () => {
  it("returns higher score when keyword in title and body", () => {
    const result = scoreSeoContent({
      title: "Malaysia e-Invoice System Guide",
      body: "The Malaysia e-Invoice system helps SMEs comply with LHDN. This Malaysia e-Invoice system is essential for businesses.",
      targetKeywords: ["Malaysia e-Invoice system"],
      locale: "en",
    });
    expect(result.score).toBeGreaterThan(50);
    expect(result.keywordDensity).toBeGreaterThan(0);
    expect(result.titleHasKeyword).toBe(true);
  });

  it("returns 0 density when no keywords match", () => {
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
  it("returns geoScore and seoScore both between 0-100", () => {
    const result = scoreDualContent({
      title: "Txpuro Malaysia e-Invoice",
      body: "Txpuro is a Malaysia e-Invoice system for SMEs integrating with MyInvois LHDN.",
      targetKeywords: ["Malaysia e-Invoice"],
      project: {
        id: "test",
        name: "Txpuro",
        brand: "Txpuro",
        product: "e-Invoice System",
        locale: "en",
        competitors: ["MyInvois Portal"],
        targetKeywords: ["Malaysia e-Invoice"],
        canonicalDomain: "txpuro.com",
      },
      prompt: "best Malaysia e-Invoice system for SMEs",
      provider: "ChatGPT",
    });
    expect(result.geoScore).toBeGreaterThanOrEqual(0);
    expect(result.geoScore).toBeLessThanOrEqual(100);
    expect(result.seoScore).toBeGreaterThanOrEqual(0);
    expect(result.seoScore).toBeLessThanOrEqual(100);
  });
});
```

运行 `npm test -- src/lib/seo/dual-optimizer.test.ts` 确认失败，然后创建 `src/lib/seo/dual-optimizer.ts`：

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

  const occurrences = countOccurrences(fullText, primaryKeyword);
  const keywordDensity = words > 0 ? (occurrences / words) * 100 : 0;
  const titleHasKeyword = primaryKeyword
    ? input.title.toLowerCase().includes(primaryKeyword.toLowerCase())
    : false;

  if (!titleHasKeyword && primaryKeyword) suggestions.push(`Add "${primaryKeyword}" to the title`);
  if (keywordDensity < 0.5 && primaryKeyword) suggestions.push(`Increase keyword density (current: ${keywordDensity.toFixed(2)}%)`);
  if (words < 300) suggestions.push("Aim for 300+ words for better SEO coverage");

  let score = 30;
  if (titleHasKeyword) score += 25;
  if (keywordDensity >= 0.5 && keywordDensity <= 3) score += 20;
  if (words >= 300) score += 15;
  score += input.targetKeywords.slice(1).filter((kw) =>
    fullText.toLowerCase().includes(kw.toLowerCase())
  ).length * 5;

  return { score: Math.min(100, score), keywordDensity, titleHasKeyword, suggestions };
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

  return { geoScore: geoResult.score, seoScore: seoResult.score, suggestions: seoResult.suggestions };
}
```

运行 `npm test -- src/lib/seo/dual-optimizer.test.ts` 确认通过，然后 commit：
```bash
git add src/lib/seo/
git commit -m "feat: add SEO dual-track scorer alongside existing GEO engine"
```

---

## TASK 3：爆款模板库

先创建测试 `src/lib/viral/templates.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { getTemplate, VIRAL_TEMPLATES, buildTemplatePrompt } from "./templates";

describe("getTemplate", () => {
  it("returns template by id", () => {
    expect(getTemplate("contrast-reveal")?.id).toBe("contrast-reveal");
  });
  it("returns undefined for unknown id", () => {
    expect(getTemplate("nonexistent")).toBeUndefined();
  });
});

describe("buildTemplatePrompt", () => {
  it("includes product name, keyword, and hook instruction", () => {
    const t = getTemplate("contrast-reveal")!;
    const prompt = buildTemplatePrompt(t, { productName: "Txpuro", keyword: "Malaysia e-Invoice", platform: "xiaohongshu" });
    expect(prompt).toContain("Txpuro");
    expect(prompt).toContain("Malaysia e-Invoice");
    expect(prompt).toContain(t.hook);
  });
});

describe("VIRAL_TEMPLATES", () => {
  it("has at least 3 templates, each with id hook and platforms", () => {
    expect(VIRAL_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    for (const t of VIRAL_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.hook).toBeTruthy();
      expect(t.platforms.length).toBeGreaterThan(0);
    }
  });
});
```

运行测试确认失败，然后创建 `src/lib/viral/templates.ts`：

```typescript
export type ViralPlatform = "xiaohongshu" | "weibo" | "linkedin" | "reddit" | "zhihu" | "tiktok" | "x" | "instagram";
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
    structure: ["痛点场景（2句话，读者能立刻认出自己）", "反直觉结论（1句，出乎意料）", "原因拆解（3点，每点一句）", "产品切入（自然带出，非硬广，1-2句）"],
    cta: "以问题结尾引发评论，例如'你们遇到过这个问题吗？'",
  },
  {
    id: "listicle-authority",
    name: "权威列举",
    platforms: ["linkedin", "reddit", "zhihu"],
    format: "long",
    hook: "数字开头：'做了X件事之后，我终于搞清楚了…'，建立权威感",
    structure: ["背景铺垫（问题严重性，2-3句）", "N个核心点（每点：加粗标题 + 2句解释）", "总结归纳（1句提炼）"],
    cta: "呼吁收藏或转发：'收藏备用，下次选型时用得上'",
  },
  {
    id: "story-arc",
    name: "故事弧",
    platforms: ["xiaohongshu", "tiktok", "instagram"],
    format: "short",
    hook: "第一句是结局，制造悬念：'我差点因为这件事损失XX万'",
    structure: ["现状（困境，读者能代入）", "转折点（发现了什么）", "解决过程（简短，不要细节堆砌）", "结果 + 产品自然露出"],
    cta: "情感共鸣收尾：'希望这个经历能帮到你们'",
  },
  {
    id: "question-answer",
    name: "问答式",
    platforms: ["zhihu", "reddit", "x"],
    format: "thread",
    hook: "以高频搜索问题开头，直接作为标题或第一行",
    structure: ["直接回答（BLUF: 第一段给答案）", "展开解释（分点，每点有依据）", "补充场景（什么情况下例外）"],
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

约束：产品自然带出，不能是硬广；不得强行拉踩竞品；与"${context.keyword}"有实质关联。
`.trim();
}
```

运行测试确认通过，然后 commit：
```bash
git add src/lib/viral/
git commit -m "feat: add viral template library with 4 templates"
```

---

## TASK 4：热搜借势构建器

创建测试 `src/lib/viral/trend-leverage.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { buildLeveragePrompt, isSafeKeyword } from "./trend-leverage";

describe("isSafeKeyword", () => {
  it("passes clean keywords", () => {
    expect(isSafeKeyword("Malaysia e-Invoice system")).toBe(true);
    expect(isSafeKeyword("电子发票 中小企业")).toBe(true);
  });
  it("blocks blacklisted keywords", () => {
    expect(isSafeKeyword("政变相关词")).toBe(false);
    expect(isSafeKeyword("暴动事件")).toBe(false);
  });
});

describe("buildLeveragePrompt", () => {
  it("contains keyword, product, and angle instruction", () => {
    const prompt = buildLeveragePrompt({ keyword: "LHDN e-Invoice deadline", productName: "Txpuro", brand: "Txpuro", platform: "linkedin" });
    expect(prompt).toContain("LHDN e-Invoice deadline");
    expect(prompt).toContain("Txpuro");
    expect(prompt).toContain("3个借势角度");
  });
});
```

运行测试确认失败，然后创建 `src/lib/viral/trend-leverage.ts`：

```typescript
const KEYWORD_BLACKLIST = ["政变", "暴动", "恐袭", "群体事件", "政治", "选举舞弊", "种族冲突"];

export function isSafeKeyword(keyword: string): boolean {
  const lower = keyword.toLowerCase();
  return !KEYWORD_BLACKLIST.some((b) => lower.includes(b.toLowerCase()));
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

约束：关联自然，不得硬广；不拉踩竞品；与"${input.keyword}"有实质关联。

输出格式：
角度1：[关联] | 钩子：[一句话] | 受众：[描述]
角度2：[关联] | 钩子：[一句话] | 受众：[描述]
角度3：[关联] | 钩子：[一句话] | 受众：[描述]
`.trim();
}
```

运行测试确认通过，然后 commit：
```bash
git add src/lib/viral/trend-leverage.ts src/lib/viral/trend-leverage.test.ts
git commit -m "feat: add trend leverage prompt builder with keyword safety filter"
```

---

## TASK 5：内容打包 API（5个路由）

依次创建以下5个文件，每个文件内容如下：

**`src/app/api/content/packages/route.ts`**
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
  return NextResponse.json({ items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null, hasMore });
}
```

**`src/app/api/content/packages/[id]/route.ts`**
```typescript
import { NextResponse } from "next/server";
import { db } from "@/lib/prisma";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const asset = await db.contentAsset.findUnique({
    where: { id: params.id },
    include: {
      variants: { include: { metrics: { orderBy: { recordedAt: "desc" }, take: 5 } } },
      trendTopic: true,
    },
  });

  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const platforms = Object.fromEntries(
    asset.variants.map((v) => [v.platform, { copy: v.copy, mediaAssets: v.mediaAssets, latestMetrics: v.metrics[0] ?? null }])
  );

  return NextResponse.json({ id: asset.id, title: asset.title, summary: asset.summary, geoScore: asset.geoScore, seoScore: asset.seoScore, trendTopic: asset.trendTopic, platforms });
}
```

**`src/app/api/content/variants/[id]/metrics/route.ts`**
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

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const parsed = Schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const variant = await db.channelVariant.findUnique({ where: { id: params.id } });
  if (!variant) return NextResponse.json({ error: "Variant not found" }, { status: 404 });

  const metric = await db.variantMetric.create({
    data: { channelVariantId: params.id, ...parsed.data, recordedAt: parsed.data.recordedAt ? new Date(parsed.data.recordedAt) : new Date() },
  });
  return NextResponse.json(metric, { status: 201 });
}
```

**`src/app/api/trends/manual/route.ts`**
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
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const topic = await db.trendTopic.create({
    data: { ...parsed.data, sourceType: "manual", capturedAt: new Date(), expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null },
  });
  return NextResponse.json(topic, { status: 201 });
}
```

**`src/app/api/trends/[id]/status/route.ts`**
```typescript
import { NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { z } from "zod";

const Schema = z.object({ status: z.enum(["approved", "rejected"]) });

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const parsed = Schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const topic = await db.trendTopic.update({ where: { id: params.id }, data: { status: parsed.data.status } });
  return NextResponse.json(topic);
}
```

运行 `npm run typecheck` 修复所有类型错误，然后 commit：
```bash
git add src/app/api/content/ src/app/api/trends/
git commit -m "feat: add content packaging API and trend management endpoints"
```

---

## TASK 6：geo-worker 服务骨架

在项目根目录创建 `geo-worker/` 子目录，并创建以下文件：

**`geo-worker/package.json`**
```json
{
  "name": "geo-worker",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun --watch run src/index.ts"
  },
  "dependencies": {
    "@trigger.dev/sdk": "^3.0.0",
    "@prisma/client": "^5.0.0",
    "zod": "^3.0.0",
    "google-trends-api": "^4.9.2",
    "@mendable/firecrawl-js": "^0.0.28"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0"
  }
}
```

**`geo-worker/src/trigger.ts`**
```typescript
import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: process.env.TRIGGER_PROJECT_REF ?? "proj_geo_ops",
  apiKey: process.env.TRIGGER_API_KEY ?? "",
  apiUrl: process.env.TRIGGER_API_URL ?? "http://localhost:3040",
});
```

**`geo-worker/src/clients/google-trends.ts`**
```typescript
// @ts-expect-error — no type defs
import googleTrends from "google-trends-api";

export interface GoogleTrendResult {
  keyword: string;
  score: number;
  platform: "google";
  region: string;
}

export async function fetchGoogleTrends(geo = "MY"): Promise<GoogleTrendResult[]> {
  try {
    const raw = await googleTrends.dailyTrends({ geo });
    const data = JSON.parse(raw as string);
    const items: { title: { query: string } }[] =
      data?.default?.trendingSearchesDays?.[0]?.trendingSearches ?? [];
    return items.slice(0, 20).map((item, i) => ({
      keyword: item.title.query,
      score: Math.max(0, 100 - i * 5),
      platform: "google" as const,
      region: geo,
    }));
  } catch {
    return [];
  }
}
```

**`geo-worker/src/clients/firecrawl.ts`**
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
              items: { type: "object", properties: { rank: { type: "number" }, keyword: { type: "string" } } },
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

**`geo-worker/src/jobs/trend-crawl.ts`**
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
    await io.logger.info("Trend crawl started");

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

    await io.logger.info("Crawl complete", { count: all.length });
    return { crawled: all.length };
  },
});
```

**`geo-worker/src/jobs/content-generate.ts`**
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
    return { topicId: payload.topicId, status: "generated" };
  },
});
```

**`geo-worker/src/jobs/seo-audit.ts`**
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
    return { audited: 0 };
  },
});
```

**`geo-worker/src/index.ts`**
```typescript
import "./jobs/trend-crawl";
import "./jobs/content-generate";
import "./jobs/seo-audit";

console.log("[geo-worker] 3 jobs registered");
```

**`geo-worker/Dockerfile`**
```dockerfile
FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY src ./src
CMD ["bun", "run", "src/index.ts"]
```

commit：
```bash
git add geo-worker/
git commit -m "feat: add geo-worker with Trigger.dev cron and event jobs"
```

---

## TASK 7：docker-compose.yml 更新

在现有 `docker-compose.yml` 的 `services:` 节点下追加：

```yaml
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data

  trigger-dev:
    image: ghcr.io/triggerdotdev/trigger.dev:latest
    restart: unless-stopped
    depends_on:
      - postgres
      - redis
    ports:
      - "3040:3000"
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=redis://redis:6379
      - SECRET_KEY=${TRIGGER_SECRET_KEY:-changeme-secret}
      - LOGIN_ORIGIN=http://localhost:3040
      - APP_ORIGIN=http://localhost:3040

  geo-worker:
    build: ./geo-worker
    restart: unless-stopped
    depends_on:
      - postgres
      - redis
      - trigger-dev
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=redis://redis:6379
      - TRIGGER_API_URL=http://trigger-dev:3000
      - TRIGGER_API_KEY=${TRIGGER_WORKER_API_KEY:-}
      - TRIGGER_PROJECT_REF=proj_geo_ops
      - FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY:-}
```

在 `volumes:` 节点下追加（没有则新建该节点）：
```yaml
  redis-data:
```

在 `.env.example` 末尾追加：
```
TRIGGER_SECRET_KEY=changeme-secret
TRIGGER_WORKER_API_KEY=
REDIS_URL=redis://localhost:6379
FIRECRAWL_API_KEY=
```

commit：
```bash
git add docker-compose.yml .env.example
git commit -m "infra: add Redis, Trigger.dev, geo-worker to docker-compose"
```

---

## TASK 8：最终验证

依次执行：

```bash
# 1. 全部单元测试
npm test
# 预期：所有测试通过

# 2. 类型检查
npm run typecheck
# 预期：无错误

# 3. 确认文件存在
ls src/lib/seo/dual-optimizer.ts
ls src/lib/viral/templates.ts
ls src/lib/viral/trend-leverage.ts
ls src/app/api/content/packages/route.ts
ls src/app/api/trends/manual/route.ts
ls geo-worker/src/index.ts
```

如果测试或类型检查有报错，修复后重新运行，直到全部通过。

最后 commit：
```bash
git add -A
git commit -m "feat: GEO+SEO dual engine + trend intelligence — complete"
```

完成。
