# GEO Content Ops

GEO Content Ops 是一个 TypeScript/Next.js MVP，用来承载 GEO 内容账号系统的总控台：

- 管理可被 AI 搜索引用的主内容资产。
- 对 ChatGPT、Perplexity、Gemini、Claude 等 provider 运行 GEO 审计。
- 生成面向 AI answer engine 的内容 brief。
- 生成官网/知识站版本和社媒平台 variants。
- 通过 GEOFlow API 创建内容生产任务。
- 通过 Postiz handoff 承接多社媒账号排期和发布。

当前系统把 GEOFlow 作为一环，而不是主底座：

- GEO Ops：GEO 监测、brief、内容资产、状态总控、Postiz handoff。
- GEOFlow：知识库、AI 内容生成、文章审核、前台信源站发布。
- Postiz：社媒账号连接、预览、排期和发布。

生产/测试环境默认不写入 demo 内容。配置 `DATABASE_URL` 后，dashboard 只展示数据库中的真实内容资产；如果没有资产，会显示空状态并允许从界面添加真实资产。
本地需要演示数据时，可以临时设置 `SEED_DEMO_DATA=true` 后运行 `npm run prisma:seed`。

生产架构说明见 [docs/architecture.md](./docs/architecture.md)。
GEOFlow 桥接落地说明见 [docs/geoflow-rollout.md](./docs/geoflow-rollout.md)。
当前目标服务器部署记录见 [docs/server-47.239.166.249-deployment.md](./docs/server-47.239.166.249-deployment.md)。

## 本地运行

```bash
npm install
npm run prisma:generate
npm run dev
```

打开 `http://localhost:3000`。

如果没有配置 provider key，GEO audit 会使用可复现的模拟回答，并返回清晰 warning。
如果没有配置 `DATABASE_URL`，GEOFlow 集成端点会返回配置错误，其他 demo dashboard 功能仍可运行。

## 生产部署

生产建议部署在 Linux 上：

- MVP：Ubuntu 22.04/24.04 LTS + Docker Compose。
- 生产推荐：容器化应用 + 托管 PostgreSQL + 托管 Redis + S3/R2 + CDN/WAF。
- 企业级：Kubernetes/ECS/Nomad + 私有 VPC + SSO + 审计日志。

最低域名：

- `geo.example.com`：GEO Ops 总控台。
- `geoflow.example.com`：GEOFlow 后台/API。
- `postiz.example.com`：Postiz 后台和 OAuth callback。
- `content.example.com`：公开内容站，也可以使用主站域名。

安全底线：

- 只暴露 80/443。
- PostgreSQL/Redis 不映射公网端口。
- 所有公网入口必须 HTTPS。
- GEO Ops 总控台和 API 必须启用登录保护；当前 MVP 使用 HTTP Basic Auth。
- 写入 API 默认要求 `x-geo-ops-action: true`，并开启 Basic Auth 登录失败限流。
- `.env`、API key、数据库密码不进 Git。
- 生产数据库开启备份和恢复演练。

仓库内提供了一个 MVP 部署样例：

```bash
docker compose -f deploy/docker-compose.prod.example.yml build
docker compose -f deploy/docker-compose.prod.example.yml up -d postgres
docker compose -f deploy/docker-compose.prod.example.yml run --rm geo-ops npm run prisma:deploy
docker compose -f deploy/docker-compose.prod.example.yml up -d
```

使用前先把 `deploy/Caddyfile.example` 里的 `geo.example.com` 改成真实域名，并准备生产 `.env`。

首次生产迁移使用：

```bash
npm run prisma:deploy
```

本地开发迁移仍可使用：

```bash
npm run prisma:migrate
```

## API

```http
POST /api/geo/audit
POST /api/geo/brief
POST /api/geo/variant
GET  /api/geo/runs
POST /api/integrations/geoflow/tasks
POST /api/integrations/geoflow/sync
GET  /api/integrations/geoflow/status
GET  /api/healthz
```

除 `GET` 和 `HEAD` 外，写入接口默认需要请求头 `x-geo-ops-action: true`。

## 环境变量

复制 `.env.example` 为 `.env` 后配置：

```bash
DATABASE_URL=

NEXT_PUBLIC_APP_URL=
PUBLIC_CONTENT_BASE_URL=
GEO_PROJECT_ID=
GEO_PROJECT_NAME=
GEO_BRAND=
GEO_PRODUCT=
GEO_LOCALE=
GEO_COMPETITORS=
GEO_TARGET_KEYWORDS=
GEO_CANONICAL_DOMAIN=
SEED_DEMO_DATA=

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

OPENAI_API_KEY=
PERPLEXITY_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
POSTIZ_BASE_URL=
POSTIZ_WEBHOOK_URL=
POSTIZ_API_KEY=
```

## GEOFlow Integration

GEO Ops 不改 GEOFlow 源码。它通过 GEOFlow REST API 创建任务：

- `POST /api/v1/tasks`
- `POST /api/v1/tasks/{id}/enqueue`
- `GET /api/v1/tasks/{id}/jobs`
- `GET /api/v1/articles`

首次数据库设置：

```bash
npm run prisma:deploy
npm run prisma:seed
```

GEOFlow token 最小权限：

- `catalog:read`
- `tasks:read`
- `tasks:write`
- `jobs:read`
- `articles:read`

桥接状态会写入 PostgreSQL：

- `ContentAsset`
- `GeoRun`
- `ChannelVariant`
- `GeoFlowTaskLink`
- `GeoFlowSyncRun`

## Postiz Integration

Postiz 独立部署，负责社媒账号连接、OAuth、排期和发布。

GEO Ops 侧生成的 variants 可以通过 `POSTIZ_WEBHOOK_URL` 或未来的 Postiz API bridge 创建草稿/排期任务。未配置 Postiz 时，variants 会保留在本地 review queue。
