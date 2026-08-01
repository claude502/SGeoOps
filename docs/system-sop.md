# GEO Ops 系统操作手册

Last updated: 2026-08-01

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

内部后台使用 Better Auth session。未登录会跳转到 `/login`；公开 guides 不需要登录。不要再使用 Basic Auth 或 `x-geo-ops-action` header。

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

### 步骤 7：发布源站链接或生成内容包

对已确定的主内容，当前系统优先做两件事：

- 发布为 `txpuro.com/guides/*` 源站链接
- 生成可交给外部分发系统的内容包

### 步骤 8：交给外部分发系统

外部分发系统负责：

- 选择平台账号
- 适配平台格式
- 排期发布
- 回传发布 URL 和发布状态

Postiz 如果继续使用，只作为可选下游分发系统之一，不再是当前系统核心职责。

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

- 把主内容整理成源站链接和内容包

### 周五

- 在外部分发系统排期
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

## 9. Phase 1 管理与恢复 SOP

### 9.1 新租户上线

1. 由 `Admin` 先创建 client；只有 `Admin` 可以创建 client 和 site integration。
2. 由 `Admin` 或 `Operator` 在已获 client scope 内依次创建 brand、site、market。
3. 从每个 API 响应记录新的 `client.id`、`brand.id`、`site.id` 和 `siteMarket.id`，再作为下一步路径参数或 integration 的 `siteMarketId`。
4. site 的 `canonicalHost` / `originHosts` 只填写 host（可带 port），不能填 URL、path、query 或 credentials。遇到 `409 Host already claimed` 时先核对现有 site，不能绕过唯一 host ownership。

完整的请求 payload 和 endpoint 见 [system-reference.md](./system-reference.md)。执行 API 请求必须保留已登录的 Better Auth session；不要把 session cookie 保存到共享脚本或工单。

### 9.2 文件 secret 与 worker

1. 在生产主机带外创建 `/opt/geo-content-ops/secrets`，目录权限 `700`。
2. 将 `sgeo_internal_secret` 通过 secret manager 或受控 SSH 放入该目录，文件权限 `600`；它不进入 Git、部署 archive、`.env` 或运行记录。
3. 其他 integration secret 也以相对路径存于该目录，并用 `file:<relative-path>` 注册到 `POST /api/sites/<site-id>/integrations`。
4. 确认 Compose 将目录只读挂载到 `/run/secrets`。`geo-worker` 只配置 `SGEO_INTERNAL_URL` 和 `SGEO_INTERNAL_SECRET_FILE`，绝不配置 `DATABASE_URL`。

### 9.3 发布前 migration 与验收

在 `/opt/geo-content-ops`，生产部署和 migration 必须带 env file：

```bash
docker compose --env-file .env -f deploy/docker-compose.prod.example.yml config --quiet
docker compose --env-file .env -f deploy/docker-compose.prod.example.yml up -d postgres
docker compose --env-file .env -f deploy/docker-compose.prod.example.yml run --rm geo-ops npm run prisma:deploy
docker compose --env-file .env -f deploy/docker-compose.prod.example.yml run --rm geo-ops npx prisma migrate status
```

验收命令：

```bash
npm test
npm run test:integration
npm run typecheck
npm run build
npm run test:integration -- \
  tests/integration/client-isolation.test.ts \
  tests/integration/txpuro-backfill.test.ts \
  tests/integration/compose-policy.test.ts
```

`npm run test:integration` 与 isolation/backfill evidence 需要专用 PostgreSQL 16 的 `TEST_DATABASE_URL` 和 schema 创建/删除权限。没有该变量时，database-backed suites 会以 `TEST_DATABASE_URL is required for database integration tests` 退出非零；记录为测试环境缺失，不得以生产数据库替代或标记通过。

### 9.4 PostgreSQL、artifact 与应用回退

1. 每日运行 `APP_DIR=/opt/geo-content-ops RETENTION_DAYS=14 bash deploy/backup-postgres.sh`，并在同一时间点建立 `artifact-data` archive。
2. 恢复前停止 `geo-ops` 与 `geo-worker`；先恢复 PostgreSQL，再恢复同一时间点的 artifacts。
3. 保留 `postgres_data`、`artifact-data` 和 `_prisma_migrations`。恢复和回退时不要运行 `prisma migrate reset`、`docker compose down -v` 或手工删除新 schema。
4. 应用回退仅重新部署已验证的旧应用 release，且不传 `-RunMigrations`。如果旧 release 不能读取新 schema，恢复与该 release 配对的数据库和 artifact backup。

完整的 PostgreSQL / artifact restore 命令和安全回退步骤见 [system-reference.md](./system-reference.md)。

## 10. 相关文档

- [system-reference.md](./system-reference.md)
- [server-47.239.166.249-deployment.md](./server-47.239.166.249-deployment.md)
- [txpuro-main-site-entry-plan.md](./txpuro-main-site-entry-plan.md)
- [txpuro-geo-strategy.md](./txpuro-geo-strategy.md)
- [content-source-and-distribution-boundary.md](./content-source-and-distribution-boundary.md)
