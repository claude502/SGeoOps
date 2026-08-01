# Deployment Notes

This folder contains a production-shaped MVP deployment example for GEO Ops.

For the current target server `47.239.166.249`, see `docs/server-47.239.166.249-deployment.md`.

Before running it:

1. Copy `.env.example` to `.env` at the repository root.
2. Replace all placeholder secrets and domains.
3. Set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`; the mandatory procedure below bootstraps the first Better Auth administrator before full startup.
4. Keep internal API access limited to signed-in tenant members.
5. For this Compose file, set `DATABASE_URL` to use host `postgres`, not `localhost`.
6. Edit `deploy/Caddyfile.example` for the real GEO Ops domain and SSL mode.
7. Make sure DNS points that domain to the Linux server or to a Cloudflare proxied record.
8. Open only ports `80` and `443` on the server firewall.
9. Provision `secrets/sgeo_internal_secret` directly on the target with directory mode `700` and file mode `600`. The deployment archive deliberately excludes `secrets/` and `.env`.

The current `wingheng.technology` test deployment uses Cloudflare edge HTTPS with HTTP origin mode to avoid redirect loops under Cloudflare `Flexible`. For production, prefer Cloudflare `Full (strict)` plus an HTTPS Caddy site block.

For a new database, run this mandatory fail-fast procedure before any full-stack start. The password is read without echo and is passed only to the one-time Compose runner; do not put it in `.env`, the archive, Git, or a command-line argument:

```bash
set -euo pipefail
cd /opt/geo-content-ops

cleanup_bootstrap_env() {
  unset SGEO_BOOTSTRAP_ADMIN_EMAIL SGEO_BOOTSTRAP_ADMIN_NAME SGEO_BOOTSTRAP_ADMIN_PASSWORD
}
trap cleanup_bootstrap_env EXIT

docker compose --env-file .env -f deploy/docker-compose.prod.example.yml build
docker compose --env-file .env -f deploy/docker-compose.prod.example.yml up -d postgres
docker compose --env-file .env -f deploy/docker-compose.prod.example.yml run --rm geo-ops npm run prisma:deploy

read -r -p 'Admin email: ' SGEO_BOOTSTRAP_ADMIN_EMAIL
read -r -p 'Admin name: ' SGEO_BOOTSTRAP_ADMIN_NAME
read -r -s -p 'Admin password: ' SGEO_BOOTSTRAP_ADMIN_PASSWORD
printf '\n'
export SGEO_BOOTSTRAP_ADMIN_EMAIL SGEO_BOOTSTRAP_ADMIN_NAME SGEO_BOOTSTRAP_ADMIN_PASSWORD
docker compose --env-file .env -f deploy/docker-compose.prod.example.yml run --rm \
  -e SGEO_BOOTSTRAP_ADMIN_EMAIL \
  -e SGEO_BOOTSTRAP_ADMIN_NAME \
  -e SGEO_BOOTSTRAP_ADMIN_PASSWORD \
  geo-ops npm run auth:bootstrap

cleanup_bootstrap_env
trap - EXIT

docker compose --env-file .env -f deploy/docker-compose.prod.example.yml run --rm geo-ops npm run auth:bootstrap:status
docker compose --env-file .env -f deploy/docker-compose.prod.example.yml up -d
```

Migration, bootstrap, status, or cleanup failure stops before full-stack `up -d`; only PostgreSQL may remain up. Correct the failure and rerun this procedure rather than starting `geo-ops`, `reverse-proxy`, or `geo-worker` by hand. `remote-deploy.ps1` does not accept bootstrap credentials: it runs the read-only `auth:bootstrap:status` gate before full startup, so use the procedure above once for a fresh database and use the script only after it succeeds.

Provision the internal signing secret separately from the code archive, using an encrypted operator channel:

```bash
ssh -i <key> root@<host> "install -d -m 700 /opt/geo-content-ops/secrets"
scp -i <key> <local-secret-file> root@<host>:/opt/geo-content-ops/secrets/sgeo_internal_secret
ssh -i <key> root@<host> "chmod 600 /opt/geo-content-ops/secrets/sgeo_internal_secret"
```

Health check:

```bash
curl -fsS http://127.0.0.1/api/healthz
docker compose --env-file .env -f deploy/docker-compose.prod.example.yml ps
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
  docker compose --env-file .env -f deploy/docker-compose.prod.example.yml exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Optional Redis service:

```bash
docker compose --env-file .env -f deploy/docker-compose.prod.example.yml --profile optional-cache up -d redis
```

The included PostgreSQL service is suitable for MVP validation. For production, prefer a managed PostgreSQL service with automatic backups and PITR.
