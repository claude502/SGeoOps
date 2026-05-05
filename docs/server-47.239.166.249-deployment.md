# 47.239.166.249 生产部署文档

## 服务器信息

| 项目 | 值 |
| --- | --- |
| 公网 IPv4 | `47.239.166.249` |
| 目标用途 | GEO 内容账号系统 MVP/试运营部署 |
| 推荐系统 | Ubuntu 24.04 LTS |
| 推荐部署方式 | Docker Compose + Caddy reverse proxy；当前由 Cloudflare 提供边缘 HTTPS |
| 应用目录 | `/opt/geo-content-ops` |
| 备份目录 | `/opt/geo-content-ops/backups` |
| 日志目录 | `/opt/geo-content-ops/logs` |

## 重要用户信息

| 用户 | 用途 | 说明 |
| --- | --- | --- |
| `root` | 初始服务器管理员 | 仅用于首次 bootstrap；部署后建议禁用密码登录 |
| `geoops` | 应用部署/运行用户 | bootstrap 脚本会创建，加入 `docker` 组 |
| `geo_ops` | PostgreSQL 应用用户 | Docker Compose MVP 数据库用户，不是 Linux 用户 |

凭证登记：

| 凭证 | 保存位置 | 记录策略 |
| --- | --- | --- |
| root 初始密码 | 用户密码管理器或云厂商控制台 | 不写入 Git，不写入本文档明文 |
| SSH deploy key | 本机 `~/.ssh/geo_ops_deploy_ed25519` | 只把 public key 写入服务器 |
| GEO Ops 管理员登录 | 本地 `.secrets/wingheng-geo-ops-credentials.md`；服务器 `/opt/geo-content-ops/.credentials/geo-ops-admin.md`；服务器 `/opt/geo-content-ops/.env` | 私有凭证文档已被 Git 忽略，不提交 Git |
| 生产 `.env` | 服务器 `/opt/geo-content-ops/.env` | 权限 `600`，不提交 Git |
| GEOFlow/Postiz/API keys | 生产 `.env` 或 secrets manager | 不提交 Git |

安全说明：

- root 初始密码已由用户在会话中提供，不写入仓库、不写入部署文档、不写入脚本。
- 完成 SSH key 登录后，必须更换 root 密码或禁用 root 密码登录。
- 生产 `.env` 只保存在服务器 `/opt/geo-content-ops/.env`，权限建议 `600`。
- GEO Ops 登录账号密码通过 `GEO_OPS_ADMIN_USERNAME`、`GEO_OPS_ADMIN_PASSWORD` 配置；明文仅写入私有凭证文档和服务器 `.env`，不提交 Git。
- 所有 API key、数据库密码、GEOFlow token、Postiz token 都不能提交到 Git。

## 域名规划

正式部署建议绑定域名：

```text
wingheng.technology          -> 47.239.166.249 或 Cloudflare proxied A/CNAME
www.wingheng.technology      -> 47.239.166.249 或 Cloudflare proxied A/CNAME
txpuro.com                  -> 47.239.166.249 或 Cloudflare proxied A/CNAME
www.txpuro.com              -> 47.239.166.249 或 Cloudflare proxied A/CNAME
geoflow.wingheng.technology  -> GEOFlow 服务
postiz.wingheng.technology   -> Postiz 服务
content.wingheng.technology  -> 公开内容站
```

当前 `wingheng.technology` 与 `www.wingheng.technology` 已通过 Cloudflare 代理访问 GEO Ops。
`txpuro.com` 主站保留给现有系统；当前 GEO 内容通过 Cloudflare Worker 路径代理方式接入：

```text
txpuro.com/guides/*            -> geo-origin.winghengtech.com
txpuro.com/llms.txt           -> geo-origin.winghengtech.com
txpuro.com/sitemap-guides.xml -> geo-origin.winghengtech.com
```

源站域名：

```text
geo-origin.winghengtech.com -> 47.239.166.249
```
如果 DNS 还没准备好，可以先用 `http://47.239.166.249` 临时验证 GEO Ops。
裸 IP 无法正常签发标准 HTTPS 证书，所以正式环境仍然需要域名。

Cloudflare SSL 策略：

- 当前测试配置兼容 Cloudflare `Flexible`：Caddy 只监听 HTTP 源站，避免 Cloudflare HTTPS -> origin HTTP 时触发源站 HTTPS redirect loop。
- 行业最佳实践是 Cloudflare `Full (strict)`：Cloudflare 到源站也走 HTTPS，并使用有效源站证书。切换到该模式前，把 `deploy/Caddyfile.example` 改回 `wingheng.technology, www.wingheng.technology { ... }` 形式，让 Caddy 自动签发/续期证书。
- 不建议长期使用 `Flexible` 承载生产敏感流量，因为 Cloudflare 到源站链路不是端到端 HTTPS。

## 端口策略

公网只开放：

```text
22/tcp   SSH，建议后续限制来源 IP 或改端口
80/tcp   HTTP，给 Caddy/Cloudflare 回源和 ACME 验证
443/tcp  HTTPS，切换 Cloudflare Full (strict) 后使用
```

不要开放：

```text
3000/tcp  Next.js app，只给 Caddy 访问
5432/tcp  PostgreSQL，不暴露公网
6379/tcp  Redis，不暴露公网
```

## 首次部署流程

### 1. 配置 SSH key

在本地生成部署 key 后，把 public key 加入服务器：

```bash
ssh-copy-id -i ~/.ssh/geo_ops_deploy_ed25519.pub root@47.239.166.249
```

如果本地是 Windows，可以在云厂商控制台把 public key 加到 root 的 `~/.ssh/authorized_keys`。

### 2. Bootstrap 服务器

登录服务器后运行：

```bash
bash /tmp/server-bootstrap.sh
```

这个脚本会做：

- 安装 Docker 和 Docker Compose plugin。
- 创建 `geoops` 用户。
- 创建 `/opt/geo-content-ops` 目录。
- 配置 UFW，只开放 SSH/HTTP/HTTPS。
- 预留备份和日志目录。

### 3. 上传代码

本仓库提供 PowerShell 部署脚本：

```powershell
.\deploy\remote-deploy.ps1 -HostName 47.239.166.249 -User root -KeyPath "$env:USERPROFILE\.ssh\geo_ops_deploy_ed25519"
```

脚本会打包当前仓库，排除 `node_modules/.next/.env/.git`，上传到 `/opt/geo-content-ops`。

### 4. 准备生产 `.env`

在服务器创建：

```bash
cd /opt/geo-content-ops
cp .env.example .env
chmod 600 .env
nano .env
```

Docker Compose MVP 使用本机 PostgreSQL 时，`DATABASE_URL` 应该使用服务名 `postgres`：

```bash
DATABASE_URL="postgresql://geo_ops:<POSTGRES_PASSWORD>@postgres:5432/geo_content_ops?schema=public"
POSTGRES_DB="geo_content_ops"
POSTGRES_USER="geo_ops"
POSTGRES_PASSWORD="<强密码>"
```

还需要设置：

```bash
NEXT_PUBLIC_APP_URL="https://geo.yourdomain.com"
PUBLIC_CONTENT_BASE_URL="https://content.yourdomain.com"
GEO_OPS_AUTH_ENABLED="true"
GEO_OPS_ADMIN_USERNAME="<admin username>"
GEO_OPS_ADMIN_PASSWORD="<strong password>"
GEO_OPS_AUTH_REALM="Wingheng GEO Ops"
GEO_OPS_AUTH_MAX_ATTEMPTS="8"
GEO_OPS_AUTH_WINDOW_SECONDS="300"
GEO_OPS_REQUIRE_ACTION_HEADER="true"
GEOFLOW_BASE_URL="https://geoflow.yourdomain.com"
GEOFLOW_API_TOKEN="<GEOFlow API token>"
GEOFLOW_STATUS_TIMEOUT_MS="2500"
GEOFLOW_TITLE_LIBRARY_ID="<catalog id>"
GEOFLOW_PROMPT_ID="<catalog id>"
GEOFLOW_AI_MODEL_ID="<catalog id>"
POSTIZ_BASE_URL="https://postiz.yourdomain.com"
POSTIZ_WEBHOOK_URL="<Postiz bridge webhook>"
POSTIZ_API_KEY="<Postiz API key>"
```

### 5. 配置 Caddy

有域名时，编辑：

```bash
nano /opt/geo-content-ops/deploy/Caddyfile.example
```

当前仓库的 `deploy/Caddyfile.example` 已按 Cloudflare `Flexible` 测试模式配置：

```caddy
http://wingheng.technology, http://www.wingheng.technology, :80 {
  encode gzip zstd
  reverse_proxy geo-ops:3000
}

geo-origin.winghengtech.com {
  encode gzip zstd
  reverse_proxy geo-ops:3000
}
```

Cloudflare Worker Routes：

```text
txpuro.com/guides
txpuro.com/guides/*
txpuro.com/llms.txt
txpuro.com/sitemap-guides.xml
```

Worker 回源目标：

```text
geo-origin.winghengtech.com
```

如果 Cloudflare 改为 `Full (strict)`，建议改成：

```caddy
wingheng.technology, www.wingheng.technology {
  encode gzip zstd
  reverse_proxy geo-ops:3000
}
```

当前测试域名为：

```text
wingheng.technology
www.wingheng.technology
```

无域名临时测试时，可以使用：

```bash
cp /opt/geo-content-ops/deploy/Caddyfile.ip.example /opt/geo-content-ops/deploy/Caddyfile.example
```

### 6. 启动服务

```bash
cd /opt/geo-content-ops
docker compose -f deploy/docker-compose.prod.example.yml build
docker compose -f deploy/docker-compose.prod.example.yml up -d postgres
docker compose -f deploy/docker-compose.prod.example.yml run --rm geo-ops npm run prisma:deploy
docker compose -f deploy/docker-compose.prod.example.yml up -d
```

### 7. 验证

未登录访问应该返回 `401`：

```bash
curl -i http://47.239.166.249/api/integrations/geoflow/status
```

带登录账号密码访问应该返回业务 JSON：

```bash
source /opt/geo-content-ops/.env
curl -u "$GEO_OPS_ADMIN_USERNAME:$GEO_OPS_ADMIN_PASSWORD" \
  http://47.239.166.249/api/integrations/geoflow/status
```

健康检查无需登录，应该返回 `200`：

```bash
curl -fsS http://47.239.166.249/api/healthz
docker compose -f deploy/docker-compose.prod.example.yml ps
```

写入接口必须带动作头，缺少 `x-geo-ops-action` 应返回 `403`：

```bash
curl -i -u "$GEO_OPS_ADMIN_USERNAME:$GEO_OPS_ADMIN_PASSWORD" \
  -X POST http://47.239.166.249/api/geo/brief \
  -H "content-type: application/json" \
  --data '{"projectId":"proj_real_workspace","keywords":["GEO"]}'
```

有域名后：

```bash
curl -u "$GEO_OPS_ADMIN_USERNAME:$GEO_OPS_ADMIN_PASSWORD" \
  https://geo.yourdomain.com/api/integrations/geoflow/status
```

当前域名：

```bash
curl -u "$GEO_OPS_ADMIN_USERNAME:$GEO_OPS_ADMIN_PASSWORD" \
  https://wingheng.technology/api/integrations/geoflow/status
```

预期：

- `databaseConfigured: true`
- GEOFlow 配置完整后 `geoFlowConfigured: true`
- Dashboard 可以打开
- 默认不展示 demo 数据；需要从界面添加真实内容资产，或通过 API 写入真实资产
- `Send to GEOFlow` 能创建 task
- `Sync GEOFlow` 能同步 published article URL

## 日常运维

查看服务：

```bash
cd /opt/geo-content-ops
docker compose -f deploy/docker-compose.prod.example.yml ps
```

查看日志：

```bash
docker compose -f deploy/docker-compose.prod.example.yml logs -f geo-ops
docker compose -f deploy/docker-compose.prod.example.yml logs -f reverse-proxy
```

重启：

```bash
docker compose -f deploy/docker-compose.prod.example.yml restart geo-ops
```

更新：

```powershell
.\deploy\remote-deploy.ps1 -HostName 47.239.166.249 -User root -KeyPath "$env:USERPROFILE\.ssh\geo_ops_deploy_ed25519" -RunMigrations
```

## 备份

MVP 本机 PostgreSQL 备份脚本：

```bash
cd /opt/geo-content-ops
APP_DIR=/opt/geo-content-ops RETENTION_DAYS=14 bash deploy/backup-postgres.sh
ls -lh /opt/geo-content-ops/backups
```

每日自动备份示例：

```bash
crontab -e
```

```cron
15 2 * * * cd /opt/geo-content-ops && APP_DIR=/opt/geo-content-ops RETENTION_DAYS=14 bash deploy/backup-postgres.sh >> /opt/geo-content-ops/logs/backup.log 2>&1
```

恢复示例：

```bash
cd /opt/geo-content-ops
gzip -dc /opt/geo-content-ops/backups/geo_content_ops-YYYYMMDD-HHMMSS.sql.gz | \
  docker compose -f deploy/docker-compose.prod.example.yml exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

生产建议把备份同步到 S3/R2，并保留 14-30 天。

## 部署后必须做

1. 更换 root 密码。
2. 添加 SSH key 登录。
3. 禁用 root 密码登录，或至少限制 SSH 来源 IP。
4. 确认 UFW 只开放 `22/80/443`。
5. 配置真实域名和 HTTPS。
6. 配置 PostgreSQL 自动备份。
7. 配置 GEOFlow token 和 catalog IDs。
8. 跑一次端到端 smoke test。
