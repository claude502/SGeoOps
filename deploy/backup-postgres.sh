#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/geo-content-ops}"
COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.prod.example.yml}"
ENV_FILE="${ENV_FILE:-.env}"
BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

cd "${APP_DIR}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${APP_DIR}/${ENV_FILE}. Create the production .env before backing up." >&2
  exit 20
fi
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

timestamp="$(date +%Y%m%d-%H%M%S)"
output="${BACKUP_DIR}/geo_content_ops-${timestamp}.sql.gz"

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip -9 > "${output}"

chmod 600 "${output}"
find "${BACKUP_DIR}" -type f -name "geo_content_ops-*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete

echo "Backup written: ${output}"
