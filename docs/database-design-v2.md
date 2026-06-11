# 数据库设计 v2

Last updated: 2026-06-11

## 1. 目标

这份设计文档面向当前系统的下一阶段演进，目标不是推翻现有 Prisma schema，而是在现有基础上明确：

- 哪些模型是长期核心模型
- 哪些字段是内容源站场景必须稳定下来的
- 哪些状态机需要正式化
- 哪些约束应该放到数据库层，而不只靠应用层逻辑

这套系统的数据库定位是：

> 围绕 `TrendTopic -> ContentAsset -> Source URL / Export Package -> Distribution Feedback` 的内容中台数据库。

## 2. 当前核心业务对象

当前系统已经具备这些基础模型：

- `TrendTopic`
- `ContentAsset`
- `ChannelVariant`
- `VariantMetric`
- `GeoRun`
- `SeoAudit`
- `KeywordRanking`
- `GeoFlowTaskLink`
- `GeoFlowSyncRun`
- `AuditEvent`

下一阶段不建议再引入平行重复模型，而是围绕这些对象扩展。

## 3. 核心业务链路

```text
TrendTopic
  -> 审批
  -> 内容生成
  -> ContentAsset
  -> ChannelVariant
  -> Source URL
  -> Export Package
  -> 外部分发系统
  -> Distribution Feedback
```

这条链路决定了数据库里最重要的不是“单篇文章”，而是：

- 热点机会
- 主内容资产
- 渠道版本
- 发布出口
- 指标与反馈

## 4. 建议的模型分层

### 4.1 情报层

#### `TrendTopic`

表示一个热点、趋势词、平台话题或人工录入话题。

建议长期保留字段：

- `id`
- `keyword`
- `platform`
- `score`
- `region`
- `sourceType`
- `status`
- `capturedAt`
- `expiresAt`
- `createdAt`

建议把 `status` 正式收敛为：

- `pending`
- `approved`
- `rejected`
- `generated`
- `archived`

说明：

- `pending`：待审批
- `approved`：已审批，允许进入生成链路
- `rejected`：明确不做
- `generated`：已经生成过主内容
- `archived`：已过时或已失效

建议未来迁移为数据库 enum，而不是继续使用任意字符串。

### 4.2 内容层

#### `ContentAsset`

表示系统中的主内容资产，是一切源站链接、导出包、变体、审计的锚点。

当前已有字段基本够用，但建议把下列字段视为正式核心字段：

- `id`
- `title`
- `body`
- `summary`
- `brandEntity`
- `sourceUrl`
- `targetKeywords`
- `canonicalUrl`
- `status`
- `geoScore`
- `seoScore`
- `owner`
- `sourceSystem`
- `externalUrl`
- `publishedAt`
- `slug`
- `locale`
- `assetType`
- `audience`
- `seoTitle`
- `metaDescription`
- `faqs`
- `schemaType`
- `ctaMode`
- `publishTarget`
- `isPublic`
- `publishedPath`
- `trendTopicId`
- `templateId`
- `createdAt`
- `updatedAt`

建议把 `status` 正式收敛为：

- `Draft`
- `Review`
- `Ready`
- `Published`
- `Archived`

当前的 `Scheduled` 对“内容源站”主资产意义不大，更适合分发层对象。

#### `ChannelVariant`

表示一个内容资产的渠道版本，不等于“账号发布记录”。

建议保留当前定位：

- 它是平台内容版本
- 不是 OAuth 账号对象
- 不是平台发帖记录对象

建议长期保留字段：

- `id`
- `contentAssetId`
- `platform`
- `accountId`
- `copy`
- `mediaAssets`
- `scheduledAt`
- `status`
- `createdAt`
- `updatedAt`

建议 `status` 收敛为：

- `Draft`
- `Review`
- `Ready`
- `Published`
- `Failed`
- `Archived`

### 4.3 质量层

#### `GeoRun`

表示一次 GEO 评估结果。

建议继续保持“可多次运行、可关联到同一个资产”的结构。

建议未来增加：

- `promptHash`
- `providerRunId`
- `latencyMs`
- `errorMessage`

#### `SeoAudit`

表示一次 SEO/技术审计结果。

建议未来增加：

- `contentAssetId`（可选）
- `source`（如 lighthouse/manual/internal）
- `issuesSummary`

#### `KeywordRanking`

表示关键词与 URL 的排名快照。

建议未来增加：

- `contentAssetId`（可选）
- `region`
- `device`

### 4.4 反馈层

#### `VariantMetric`

这是渠道版本的表现指标，当前有：

- `impressions`
- `clicks`
- `shares`
- `recordedAt`

建议未来增加：

- `likes`
- `comments`
- `bookmarks`
- `ctr`
- `engagementRate`
- `source`

## 5. 新增建议模型

下一阶段建议新增 3 个模型。

### 5.1 `ExportPackage`

用途：

- 给外部分发系统提供稳定、幂等、可追踪的内容包

建议字段：

- `id`
- `contentAssetId`
- `version`
- `language`
- `status`
- `packageType`
- `payload`（Json）
- `recommendedPlatforms`（String[]）
- `sourceUrl`
- `createdAt`
- `updatedAt`

建议 `status`：

- `ready`
- `claimed`
- `dispatched`
- `failed`
- `archived`

建议数据库约束：

- `@@index([contentAssetId])`
- `@@index([status])`
- `@@unique([contentAssetId, version, language])`

### 5.2 `DistributionDispatch`

用途：

- 记录外部分发系统的接收与投递情况

建议字段：

- `id`
- `exportPackageId`
- `contentAssetId`
- `platform`
- `accountId`
- `externalPostId`
- `publishedUrl`
- `status`
- `errorMessage`
- `publishedAt`
- `createdAt`
- `updatedAt`

建议 `status`：

- `accepted`
- `scheduled`
- `published`
- `failed`
- `deleted`

建议约束：

- `@@index([exportPackageId])`
- `@@index([contentAssetId])`
- `@@index([platform, status])`

### 5.3 `EventDelivery`

用途：

- 记录内部事件投递，避免“状态已经改了，但事件没投递成功”

建议字段：

- `id`
- `eventName`
- `entityType`
- `entityId`
- `payload`
- `target`
- `status`
- `attemptCount`
- `lastError`
- `lastAttemptAt`
- `createdAt`

建议 `status`：

- `pending`
- `sent`
- `failed`
- `abandoned`

## 6. 应该下沉到数据库层的约束

这一部分很关键。下一阶段不要只靠应用层判断。

### 6.1 热点唯一性

当前 `TrendTopic` 已有：

- `@@unique([keyword, platform])`

这个唯一性适合“热点池去重”，保留。

### 6.2 趋势生成资产幂等键

对 `ContentAsset`，建议新增组合唯一键思路：

- `sourceSystem + trendTopicId + templateId + locale`

如果当前 Prisma/业务上不想立即做硬唯一约束，至少应先新增索引：

- `@@index([sourceSystem, trendTopicId, templateId, locale])`

当趋势链路稳定后，再升级为真正唯一约束。

### 6.3 源站路径唯一性

建议对公开资产增加唯一性约束思路：

- `publishTarget + publishedPath + locale`

否则后面 `/guides/*` 很容易发生路径冲突。

### 6.4 导出包版本唯一性

建议：

- `ExportPackage(contentAssetId, version, language)` 唯一

这样下游系统就能拿到明确版本，不会抓到语义不稳定的旧包。

## 7. 状态机建议

### 7.1 TrendTopic 状态机

```text
pending
  -> approved
  -> rejected

approved
  -> generated
  -> archived

generated
  -> archived

rejected
  -> archived
```

原则：

- `trend-crawl` 不应该把 `approved/generated` 自动打回 `pending`
- 重新启用旧热点应该是显式操作，而不是爬虫覆盖

### 7.2 ContentAsset 状态机

```text
Draft
  -> Review
  -> Ready

Review
  -> Ready
  -> Draft

Ready
  -> Published
  -> Archived

Published
  -> Archived
```

### 7.3 ExportPackage 状态机

```text
ready
  -> claimed
  -> dispatched
  -> failed

failed
  -> ready

dispatched
  -> archived
```

## 8. 当前 schema 对照改造优先级

### 第一优先级

- 为 `ContentAsset` 增加趋势链路幂等索引
- 正式化 `TrendTopic.status`
- 正式化 `ContentAsset.status`
- 统一 canonical URL 与 publishedPath 的语义

### 第二优先级

- 新增 `ExportPackage`
- 新增 `DistributionDispatch`
- 新增 `EventDelivery`

### 第三优先级

- 为 `SeoAudit` / `KeywordRanking` 增加 `contentAssetId`
- 增加多维表现指标
- 为未来 BI/分析增加聚合视图

## 9. 建议的 Prisma 演进顺序

建议按下面顺序走迁移：

1. 新增索引，不改业务含义
2. 新增 `ExportPackage`
3. 新增 `DistributionDispatch`
4. 新增 `EventDelivery`
5. 收敛状态字段为 enum
6. 再考虑唯一约束升级

这样最稳，能避免一次迁移带太多破坏性变更。

## 10. 一句话结论

数据库 v2 的核心思路不是“再加更多表”，而是：

> 让趋势、主内容、源站链接、导出包、分发反馈之间形成一条真正稳定且可追踪的数据链。
