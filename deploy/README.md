# Deployment Notes

This folder contains a production-shaped MVP deployment example for GEO Ops.

For the current target server `47.239.166.249`, see `docs/server-47.239.166.249-deployment.md`.

Before running it:

1. Copy `.env.example` to `.env` at the repository root.
2. Replace all placeholder secrets and domains.
3. Set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`, then bootstrap the first Better Auth administrator.
4. Keep internal API access limited to signed-in tenant members.
5. For this Compose file, set `DATABASE_URL` to use host `postgres`, not `localhost`.
6. Edit `deploy/Caddyfile.example` for the real GEO Ops domain and SSL mode.
7. Make sure DNS points that domain to the Linux server or to a Cloudflare proxied record.
8. Open only ports `80` and `443` on the server firewall.

The current `wingheng.technology` test deployment uses Cloudflare edge HTTPS with HTTP origin mode to avoid redirect loops under Cloudflare `Flexible`. For production, prefer Cloudflare `Full (strict)` plus an HTTPS Caddy site block.

Run:

```bash
docker compose -f deploy/docker-compose.prod.example.yml build
docker compose -f deploy/docker-compose.prod.example.yml up -d postgres
docker compose -f deploy/docker-compose.prod.example.yml run --rm geo-ops npm run prisma:deploy
docker compose -f deploy/docker-compose.prod.example.yml up -d
```

Health check:

```bash
curl -fsS http://127.0.0.1/api/healthz
docker compose -f deploy/docker-compose.prod.example.yml ps
```

Database backup:

```bash
APP_DIR=/opt/geo-content-ops RETENTION_DAYS=14 bash deploy/backup-postgres.sh
```

Daily cron example:

```cron
15 2 * * * cd /opt/geo-content-ops && APP_DIR=/opt/geo-content-ops RETENTION_DAYS=14 bash deploy/backup-postgres.sh >> /opt/geo-content-ops/logs/backup.log 2>&1
```

Restore example:

```bash
gzip -dc /opt/geo-content-ops/backups/geo_content_ops-YYYYMMDD-HHMMSS.sql.gz | \
  docker compose -f deploy/docker-compose.prod.example.yml exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Optional Redis service:

```bash
docker compose -f deploy/docker-compose.prod.example.yml --profile optional-cache up -d redis
```

The included PostgreSQL service is suitable for MVP validation. For production, prefer a managed PostgreSQL service with automatic backups and PITR.
