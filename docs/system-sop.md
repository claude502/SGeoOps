# GEO Ops 系统操作手册

Last updated: 2026-05-05

## 1. 这份手册给谁用

适用对象：

- 运营
- 内容负责人
- GEO 监测负责人
- 实施或售前支持

目标：

- 知道每天怎么用这套系统
- 知道什么入口在哪
- 知道什么时候去看后台，什么时候去看公开 guides

## 2. 每日使用入口

### 内部后台

- `https://wingheng.technology`

用途：

- 创建内容资产
- 运行 GEO 审计
- 管理 GEOFlow 和 Postiz

### 对外内容区

- `https://txpuro.com/guides`

用途：

- 对外承接 AI 搜索和自然流量
- 给客户、销售、实施团队发送内容链接

## 3. 标准工作流

### 步骤 1：创建内容资产

在后台创建一条 `ContentAsset`。

建议先填：

- Title
- Body
- Brand Entity
- Canonical URL
- Target Keywords
- Locale
- Asset Type
- Audience

如果是公开内容页：

- `isPublic = true`
- `publishTarget = txpuro`

### 步骤 2：生成 brief

对内容资产生成 GEO brief。

目标：

- 明确搜索意图
- 明确实体覆盖
- 明确 FAQ
- 明确适用对象

### 步骤 3：运行 GEO audit

对页面或内容运行 GEO 审计。

系统会记录：

- provider
- answer
- score
- cited domains
- recommendations

使用时机：

- 新页面上线前
- 重要页面修改后
- 每周复盘

### 步骤 4：决定内容去向

分两种：

#### A. 直接作为 guides 公共内容

适合：

- FAQ
- 指南页
- 功能页
- 对比页

#### B. 发到 GEOFlow 继续长文流程

适合：

- 需要 AI 初稿
- 需要编辑审核
- 需要前台信源站发布

### 步骤 5：发送 GEOFlow

在后台点 `Send to GEOFlow`。

系统会：

- 创建 GEOFlow task
- enqueue
- 记录 task link

### 步骤 6：同步 GEOFlow

在 GEOFlow 发布后，回到后台点 `Sync GEOFlow`。

系统会把：

- GEOFlow task 状态
- article URL
- published 时间

同步回当前资产。

### 步骤 7：生成渠道版本

对已确定的主内容生成：

- LinkedIn
- X
- WeChat
- Xiaohongshu

### 步骤 8：交给 Postiz

用于：

- 预览
- 排期
- 发布

## 4. Txpuro guides 运营优先级

每天优先看的内容区：

1. `guides` 首页
2. FAQ
3. `what-is-myinvois`
4. `malaysia-einvoice-implementation-timeline`
5. `txpuro-vs-myinvois-portal`
6. `pricing`

这些页优先级最高，因为它们最接近高意图问题。

## 5. 内容页分类建议

### money-page

适合：

- 首页
- pricing
- contact

### feature-page

适合：

- MyInvois integration
- API integration
- bulk import

### guide-page

适合：

- 时间线
- MyInvois 是什么
- SME 上线路径

### compare-page

适合：

- vs portal
- vs manual
- vs custom build

### faq-page

适合：

- 总 FAQ

## 6. 每周运营节奏

### 周一

- 看上周新增页面
- 跑重点页 GEO audit

### 周二

- 补 FAQ
- 修正文案和引用结构

### 周三

- 做对比页或功能页

### 周四

- 把主内容生成渠道 variants

### 周五

- 在 Postiz 排期
- 复盘 AI 提及与引用变化

## 7. 出问题先查哪里

### 后台打不开

先看：

- `https://wingheng.technology`
- `/api/healthz`
- docker compose 状态

### guides 打不开

先看：

- `https://txpuro.com/guides`
- `https://geo-origin.winghengtech.com/guides`
- Cloudflare Worker routes

### llms 或 sitemap 异常

检查：

- `/llms.txt`
- `/sitemap-guides.xml`

### GEOFlow 发不过去

检查：

- GEOFlow token
- catalog IDs
- `/api/integrations/geoflow/status`

### 发布状态没回来

检查：

- `Sync GEOFlow`
- `GeoFlowTaskLink`
- GEOFlow article 是否已发布

## 8. 当前公开可发给客户的地址

- [Txpuro Guides 首页](https://txpuro.com/guides)
- [什么是 MyInvois](https://txpuro.com/guides/what-is-myinvois)
- [实施时间线](https://txpuro.com/guides/malaysia-einvoice-implementation-timeline)
- [FAQ](https://txpuro.com/guides/faq)
- [Txpuro vs MyInvois Portal](https://txpuro.com/guides/compare/txpuro-vs-myinvois-portal)

## 9. 相关文档

- [system-reference.md](./system-reference.md)
- [server-47.239.166.249-deployment.md](./server-47.239.166.249-deployment.md)
- [txpuro-main-site-entry-plan.md](./txpuro-main-site-entry-plan.md)
- [txpuro-geo-strategy.md](./txpuro-geo-strategy.md)
