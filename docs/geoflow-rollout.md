# GEOFlow Bridge 落地方案

## 目标

将 GEOFlow 作为 GEO 内容账号系统的一环，而不是替代 GEO Ops 总控台。

- GEO Ops 负责 GEO 监测、brief、内容资产、社媒 variants、Postiz handoff。
- GEOFlow 负责知识库辅助内容生成、文章审核、前台信源站发布。
- Postiz 负责多社媒账号连接、预览、排期、发布。

生产部署拓扑见 [architecture.md](./architecture.md)。

## 桥接方式

第一版不改 GEOFlow 源码，不做 GEOFlow 原生 webhook。
GEO Ops 通过 GEOFlow REST API 创建任务，并通过手动或定时 sync 轮询状态。

```text
GEO Ops Dashboard
  -> POST /api/integrations/geoflow/tasks
  -> GEOFlow /api/v1/tasks
  -> GEOFlow /api/v1/tasks/{id}/enqueue
  -> GEOFlow article review and publish
  -> POST /api/integrations/geoflow/sync
  -> PostgreSQL ContentAsset + GeoFlowTaskLink update
  -> Generate social variants
  -> Postiz handoff
```

## 必需服务

- GEO Ops：当前 Next.js 应用，总控台。
- PostgreSQL：保存内容资产、GEOFlow task link、sync run。
- GEOFlow：独立部署的 Laravel 应用。
- Postiz：独立部署的社媒排期发布系统。
- 反向代理/CDN：生产环境负责 HTTPS、证书、访问控制。

MVP 可以部署在一台 Linux VPS 上；生产推荐把 PostgreSQL、Redis、对象存储改为托管服务。

## 环境变量

复制 `.env.example` 到 `.env` 后配置：

```bash
DATABASE_URL=

NEXT_PUBLIC_APP_URL=
PUBLIC_CONTENT_BASE_URL=

GEO_OPS_AUTH_ENABLED=
GEO_OPS_ADMIN_USERNAME=
GEO_OPS_ADMIN_PASSWORD=
GEO_OPS_AUTH_REALM=
GEO_OPS_AUTH_MAX_ATTEMPTS=
GEO_OPS_AUTH_WINDOW_SECONDS=
GEO_OPS_REQUIRE_ACTION_HEADER=

GEOFLOW_BASE_URL=
GEOFLOW_API_TOKEN=
GEOFLOW_PUBLIC_BASE_URL=
GEOFLOW_STATUS_TIMEOUT_MS=
GEOFLOW_TITLE_LIBRARY_ID=
GEOFLOW_PROMPT_ID=
GEOFLOW_AI_MODEL_ID=
GEOFLOW_AUTHOR_ID=
GEOFLOW_KNOWLEDGE_BASE_ID=
GEOFLOW_FIXED_CATEGORY_ID=

POSTIZ_BASE_URL=
POSTIZ_WEBHOOK_URL=
POSTIZ_API_KEY=
```

GEOFlow token 最小权限：

- `catalog:read`
- `tasks:read`
- `tasks:write`
- `jobs:read`
- `articles:read`

## 部署步骤

本地开发：

```bash
npm install
npm run prisma:generate
npm run dev
```

生产部署：

```bash
npm install
npm run prisma:generate
npm run build
npm run prisma:deploy
npm run start
```

Docker Compose MVP：

```bash
docker compose -f deploy/docker-compose.prod.example.yml build
docker compose -f deploy/docker-compose.prod.example.yml up -d postgres
docker compose -f deploy/docker-compose.prod.example.yml run --rm geo-ops npm run prisma:deploy
docker compose -f deploy/docker-compose.prod.example.yml up -d
```

部署前需要把 `deploy/Caddyfile.example` 中的示例域名改为真实域名，并准备生产 `.env`。

检查 GEOFlow bridge：

```bash
curl https://geo.example.com/api/integrations/geoflow/status
```

## 操作流程

1. 用户在 GEO Ops 创建或选择内容 brief。
2. 点击 `Send to GEOFlow`。
3. GEO Ops 校验 GEOFlow 配置和 catalog IDs。
4. GEO Ops 创建 `GeoFlowTaskLink`，用 idempotency key 调用 GEOFlow `POST /tasks`。
5. 创建成功后立即调用 `POST /tasks/{id}/enqueue`。
6. 用户在 GEOFlow 审核并发布文章。
7. 用户点击 `Sync GEOFlow`，或后台定时调用 sync。
8. Sync 读取 linked task 的 jobs/articles。
9. 如果 GEOFlow article 已发布：
   - 更新 `GeoFlowTaskLink.status = published`。
   - 更新 `ContentAsset.canonicalUrl/externalUrl/publishedAt`。
   - Dashboard 显示可继续 `Generate Variants` 给 Postiz。

## 数据模型

- `ContentAsset`：GEO Ops 追踪的主内容资产。
- `GeoRun`：GEO 监测结果，关联内容资产并回写最近平均分。
- `ChannelVariant`：官网/知识站和社媒渠道版本。
- `GeoFlowTaskLink`：GEO Ops content asset 和 GEOFlow task/job/article 的映射。
- `GeoFlowSyncRun`：每次同步的审计记录。
- `AuditEvent`：关键写入动作的操作审计，便于排查和后续 RBAC/SSO 扩展。

Bridge 状态：

- `not_sent`
- `queued`
- `generating`
- `reviewing`
- `published`
- `failed`

## 验收标准

- `GET /api/integrations/geoflow/status` 返回 `databaseConfigured: true`。
- 必填 `GEOFLOW_*` 值存在时 `geoFlowConfigured: true`。
- 推送 asset 到 GEOFlow 时只创建一个 `GeoFlowTaskLink`。
- 同一个 asset + brief 重复提交不会重复创建任务。
- Sync 能更新 task/job/article IDs。
- GEOFlow 文章发布后，dashboard 显示 `published` 和 article URL。
- published asset 仍可继续生成 LinkedIn、X、微信公众号等社媒 variants。

## 失败处理

- 缺少 `DATABASE_URL`：integration endpoints 返回 `503` 并指出缺失 key。
- 缺少 GEOFlow 配置：integration endpoints 返回 `503` 并指出缺失 `GEOFLOW_*` keys。
- GEOFlow 401/422/500：GEO Ops 返回稳定错误结构，并在存在 task link 时记录 `lastError`。
- task 创建成功但 enqueue 失败：保留 task link，并标记 `failed`。
- sync 失败：`GeoFlowSyncRun` 记录成功数、失败数和错误摘要。

## 回滚

- 移除或清空 `GEOFLOW_API_TOKEN` 即可停用 GEOFlow bridge。
- GEO audit、brief、variant 生成仍可继续运行。
- 数据库记录不在回滚时删除。
- Postiz handoff 保持独立。

## 当前执行状态

已完成：

- Prisma schema 和 migration。
- 真实内容资产、GEO runs、channel variants 持久化。
- GEOFlow REST client。
- idempotent task creation。
- PostgreSQL bridge repository。
- integration APIs：task、sync、status。
- Dashboard：`Send to GEOFlow`、`Sync GEOFlow`、article URL 展示。
- 单元测试：headers、配置校验、idempotency、enqueue failure、published sync。
- 生产架构文档和 Docker Compose/Caddy 样例。

待真实环境执行：

- 配置生产 `DATABASE_URL`。
- 执行 `npm run prisma:deploy`。
- 配置真实 GEOFlow token 和 catalog IDs。
- 配置真实 Postiz webhook/API。
- 跑一次真实 GEOFlow publish cycle。
