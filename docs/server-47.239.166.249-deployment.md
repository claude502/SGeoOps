# 47.239.166.249 生产部署文档

## 服务器信息

| 项目 | 值 |
| --- | --- |
| 公网 IPv4 | `47.239.166.249` |
| 目标用途 | GEO 内容账号系统 MVP/试运营部署 |
| 推荐系统 | Ubuntu 24.04 LTS |
| 推荐部署方式 | Docker Compose + Caddy HTTPS reverse proxy |
| 应用目录 | `/opt/geo-content-ops` |
| 备份目录 | `/opt/geo-content-ops/backups` |
| 日志目录 | `/opt/geo-content-ops/logs` |

## 重要用户信息

| 用户 | 用途 | 说明 |
| --- | --- | --- |
| `root` | 初始服务器管理员 | 仅用于首次 bootstrap；部署后建议禁用密码登录 |
| `geoops` | 应用部署/运行用户 | bootstrap 脚本会创建，加入 `docker` 组 |
| `geo_ops` | PostgreSQL 应用用户 | Docker Compose MVP 数据库用户，不是 Linux 用户 |

安全说明：

- root 初始密码已由用户在会话中提供，不写入仓库、不写入部署文档、不写入脚本。
- 完成 SSH key 登录后，必须更换 root 密码或禁用 root 密码登录。
- 生产 `.env` 只保存在服务器 `/opt/geo-content-ops/.env`，权限建议 `600`。
- 所有 API key、数据库密码、GEOFlow token、Postiz token 都不能提交到 Git。

## 域名规划

正式部署建议绑定域名：

```text
geo.yourdomain.com       -> 47.239.166.249
geoflow.yourdomain.com   -> GEOFlow 服务
postiz.yourdomain.com    -> Postiz 服务
content.yourdomain.com   -> 公开内容站
```

如果域名还没准备好，可以先用 `http://47.239.166.249` 临时验证 GEO Ops。
裸 IP 无法正常签发标准 HTTPS 证书，所以正式环境仍然需要域名。

## 端口策略

公网只开放：

```text
22/tcp   SSH，建议后续限制来源 IP 或改端口
80/tcp   HTTP，给 Caddy 跳转 HTTPS/临时验证
443/tcp  HTTPS
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
GEOFLOW_BASE_URL="https://geoflow.yourdomain.com"
GEOFLOW_API_TOKEN="<GEOFlow API token>"
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

把 `geo.example.com` 替换为真实域名。

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

```bash
curl http://47.239.166.249/api/integrations/geoflow/status
```

有域名后：

```bash
curl https://geo.yourdomain.com/api/integrations/geoflow/status
```

预期：

- `databaseConfigured: true`
- GEOFlow 配置完整后 `geoFlowConfigured: true`
- Dashboard 可以打开
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

MVP 本机 PostgreSQL 备份：

```bash
cd /opt/geo-content-ops
mkdir -p backups
docker compose -f deploy/docker-compose.prod.example.yml exec -T postgres \
  pg_dump -U geo_ops -d geo_content_ops -Fc > backups/geo_content_ops_$(date +%F_%H%M).dump
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
