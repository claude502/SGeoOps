# 账号与凭证文档说明

Last updated: 2026-05-05

这份文档说明系统相关账号、密码、token 和环境变量分别记录在哪里，以及哪些文档可以提交到 Git，哪些只能保留在本地私密目录。

## 1. 文档分层

当前账号与部署资料分为两层：

- `docs/`
  公开项目文档。可以提交到 Git，不包含明文密码、API key、数据库连接密码。
- `.secrets/`
  本地私密文档。只保留在当前工作区，本目录已被 `.gitignore` 忽略，不提交到 Git。

## 2. 当前应查看的文档

公开文档：

- [系统总手册](./system-reference.md)
- [系统操作手册](./system-sop.md)
- [47.239.166.249 部署文档](./server-47.239.166.249-deployment.md)
- [本地文档索引](./wingheng-local-ops-index.md)

私密文档：

- `.secrets/wingheng-geo-ops-credentials.md`
- `.secrets/wingheng-prod.env.snapshot`

## 3. 各类账号保存位置

| 类型 | 保存位置 | 说明 |
| --- | --- | --- |
| 服务器 SSH 登录信息 | `.secrets/wingheng-geo-ops-credentials.md` | 包括服务器 IP、SSH 用户、当前测试期登录方式、常用远程命令 |
| GEO Ops Basic Auth 账号 | `.secrets/wingheng-geo-ops-credentials.md` | 内部后台 `wingheng.technology` 登录凭证 |
| PostgreSQL 凭证 | `.secrets/wingheng-geo-ops-credentials.md` | 同时参考 `.secrets/wingheng-prod.env.snapshot` |
| 生产 `.env` 快照 | `.secrets/wingheng-prod.env.snapshot` | 从远端 `/opt/geo-content-ops/.env` 拉回的快照 |
| GEOFlow / Postiz / AI provider keys | `.secrets/wingheng-geo-ops-credentials.md` | 未配置项也在该文档明确标记 |
| Cloudflare / Worker 路由说明 | `docs/server-47.239.166.249-deployment.md` | 只写接入方式，不写 Cloudflare 账号密码 |

## 4. 当前线上涉及的入口

- 内部后台：`https://wingheng.technology`
- Txpuro GEO 内容入口：`https://txpuro.com/guides`
- Cloudflare 回源入口：`https://geo-origin.winghengtech.com`

其中：

- `wingheng.technology` 的登录账号密码在 `.secrets/wingheng-geo-ops-credentials.md`
- `txpuro.com/guides/*` 通过 Cloudflare Worker routes 接入当前系统
- `geo-origin.winghengtech.com` 只是回源专用入口，不作为对外业务账号入口

## 5. 维护原则

- 明文密码、API key、数据库密码只写入 `.secrets/` 或远端 `.env`
- `docs/` 中只保留位置说明、流程说明、部署说明
- 账号发生轮换后，优先更新：
  - `.secrets/wingheng-geo-ops-credentials.md`
  - `.secrets/wingheng-prod.env.snapshot`
- 如果部署结构变化，同时更新：
  - [system-reference.md](./system-reference.md)
  - [server-47.239.166.249-deployment.md](./server-47.239.166.249-deployment.md)
  - [wingheng-local-ops-index.md](./wingheng-local-ops-index.md)
