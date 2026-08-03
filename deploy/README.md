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
9. Provision `secrets/sgeo_internal_secret` directly on the target with directory owner/group `root:10001` and mode `0750`, and file owner/group `root:10001` and mode `0640`. The non-root geo-worker image runs as UID/GID `10001`, so this grants only its group read/traverse access. The deployment archive deliberately excludes `secrets/` and `.env`.

The current `wingheng.technology` test deployment uses Cloudflare edge HTTPS with HTTP origin mode to avoid redirect loops under Cloudflare `Flexible`. For production, prefer Cloudflare `Full (strict)` plus an HTTPS Caddy site block.

## Trigger.dev v4 Production Precondition

This SGeoOps production Compose stack intentionally does not start `geo-worker` or deploy Trigger tasks. A local `trigger dev` process is for the development Compose lifecycle only and is not a production worker deployment.

Provision Trigger.dev v4.5.9 separately with the official pinned webapp and worker/runner stack, then deploy this task project from CI/CD with `TRIGGER_API_URL` and `TRIGGER_ACCESS_TOKEN` supplied through the CI secret store. The concrete generated self-host configuration and production runbook are delivered in Phase 2 Task 9; this Compose file does not claim that Trigger.dev is already deployed.

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

Migration, bootstrap, status, or cleanup failure stops before full-stack `up -d`; only PostgreSQL may remain up. Correct the failure and rerun this procedure rather than starting `geo-ops` or `reverse-proxy` by hand. `remote-deploy.ps1` does not accept bootstrap credentials: it runs the read-only `auth:bootstrap:status` gate before full startup, so use the procedure above once for a fresh database and use the script only after it succeeds.

Provision the internal signing secret separately from the code archive, using an encrypted operator channel:

```bash
ssh -i <key> root@<host> "install -d -o root -g 10001 -m 0750 /opt/geo-content-ops/secrets"
scp -i <key> <local-secret-file> root@<host>:/opt/geo-content-ops/secrets/sgeo_internal_secret
ssh -i <key> root@<host> "chown root:10001 /opt/geo-content-ops/secrets/sgeo_internal_secret && chmod 0640 /opt/geo-content-ops/secrets/sgeo_internal_secret"
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

Matomo Core is pinned to `5.12.0` and runs with a pinned separate MariaDB,
an hourly archive service, dedicated volumes, and private networks. Neither Matomo nor
MariaDB publishes a host port. Only `geo-ops` and the development worker join
`matomo-reporting`; the reverse proxy and archive service do not. Supply
`MATOMO_DATABASE_PASSWORD` and `MATOMO_DATABASE_ROOT_PASSWORD` through the deployment
secret environment with no defaults. After initial Matomo setup, disable browser-triggered
archiving in Matomo so the healthy hourly archive container is the only report archiver.

Create a permission-restricted backup only while `matomo-db` is running:

```bash
MATOMO_BACKUP_DIR=/opt/geo-content-ops/backups/matomo \
MATOMO_COMPOSE_FILE=deploy/docker-compose.prod.example.yml \
bash deploy/backup-matomo.sh
```

The script requires an absolute non-symlink backup directory, validates Docker/Compose and
the running database service, writes atomically with mode `0600`, and removes expired dumps.
It builds a temporary MariaDB option file inside the database container so the password does
not appear in process arguments or output.

For restore, stop `matomo` and `matomo-archive-cron`, validate the selected backup with
`gzip -t`, take a fresh safety backup, and use the same temporary option-file pattern:

```bash
BACKUP=/opt/geo-content-ops/backups/matomo/matomo-YYYYMMDDTHHMMSSZ.sql.gz
gzip -t "$BACKUP"
gzip -dc "$BACKUP" | docker compose --env-file .env \
  -f deploy/docker-compose.prod.example.yml exec -T matomo-db sh -ec '
    set -eu
    umask 077
    defaults=$(mktemp /tmp/matomo-client.XXXXXX)
    trap '\''rm -f -- "$defaults"'\'' EXIT HUP INT TERM
    {
      printf '\''[client]\n'\''
      printf '\''user=%s\n'\'' "$MARIADB_USER"
      printf '\''password=%s\n'\'' "$MARIADB_PASSWORD"
    } >"$defaults"
    mariadb --defaults-extra-file="$defaults" "$MARIADB_DATABASE"
  '
```

Restart both services and run `php /var/www/html/console core:archive --force-all-websites`
inside `matomo-archive-cron`. A restore replaces Matomo database state. Production Trigger
worker deployment is still delivered by Phase 2 Task 9; this Compose change does not claim it exists.

Optional Redis service:

```bash
docker compose --env-file .env -f deploy/docker-compose.prod.example.yml --profile optional-cache up -d redis
```

The included PostgreSQL service is suitable for MVP validation. For production, prefer a managed PostgreSQL service with automatic backups and PITR.
