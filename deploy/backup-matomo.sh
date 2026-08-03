#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

backup_dir=${MATOMO_BACKUP_DIR:-}
retention_days=${MATOMO_BACKUP_RETENTION_DAYS:-14}
compose_file=${MATOMO_COMPOSE_FILE:-deploy/docker-compose.prod.example.yml}

[[ -n "$backup_dir" && "$backup_dir" == /* ]] ||
  fail "MATOMO_BACKUP_DIR must be an absolute path." 64
[[ "$retention_days" =~ ^[1-9][0-9]{0,3}$ ]] ||
  fail "MATOMO_BACKUP_RETENTION_DAYS must be between 1 and 9999." 64
[[ -f "$compose_file" ]] || fail "Matomo compose file was not found." 66
command -v docker >/dev/null 2>&1 || fail "Docker is required." 69
docker info >/dev/null 2>&1 || fail "Docker is unavailable." 69
docker compose version >/dev/null 2>&1 || fail "Docker Compose is unavailable." 69

compose=(docker compose -f "$compose_file")
configured_services=$("${compose[@]}" config --services) ||
  fail "The Matomo Compose configuration is invalid." 78
grep -Fxq "matomo-db" <<<"$configured_services" ||
  fail "The Matomo database service is not configured." 69
running_services=$("${compose[@]}" ps --status running --services) ||
  fail "Unable to inspect Matomo services." 69
grep -Fxq "matomo-db" <<<"$running_services" ||
  fail "The Matomo database service is not running." 69

while [[ "$backup_dir" != "/" && "$backup_dir" == */ ]]; do
  backup_dir=${backup_dir%/}
done
install -d -m 0700 -- "$backup_dir"
resolved_backup_dir=$(cd -- "$backup_dir" && pwd -P)
[[ "$resolved_backup_dir" == "$backup_dir" ]] ||
  fail "MATOMO_BACKUP_DIR must not resolve through symbolic links." 64
chmod 0700 -- "$backup_dir"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
output="$backup_dir/matomo-$timestamp.sql.gz"
[[ ! -e "$output" ]] || fail "A Matomo backup already exists for this timestamp." 73
temporary=$(mktemp "$backup_dir/.matomo-backup.XXXXXX")
cleanup() {
  rm -f -- "$temporary"
}
trap cleanup EXIT HUP INT TERM

database_dump=$(cat <<'SH'
set -eu
umask 077
defaults=$(mktemp /tmp/matomo-client.XXXXXX)
cleanup_defaults() {
  rm -f -- "$defaults"
}
trap cleanup_defaults EXIT HUP INT TERM
{
  printf '[client]\n'
  printf 'user=%s\n' "$MARIADB_USER"
  printf 'password=%s\n' "$MARIADB_PASSWORD"
} >"$defaults"
mariadb-admin --defaults-extra-file="$defaults" ping --silent >/dev/null
mariadb-dump \
  --defaults-extra-file="$defaults" \
  --single-transaction \
  --quick \
  --lock-tables=false \
  "$MARIADB_DATABASE"
SH
)

"${compose[@]}" exec -T matomo-db sh -ec "$database_dump" | gzip -9 >"$temporary"
[[ -s "$temporary" ]] || fail "Matomo backup output is empty." 74
gzip -t -- "$temporary"
chmod 0600 -- "$temporary"
mv -- "$temporary" "$output"

find "$backup_dir" \
  -maxdepth 1 \
  -type f \
  -name 'matomo-????????T??????Z.sql.gz' \
  -mtime "+$retention_days" \
  -delete

printf 'Matomo backup created: %s\n' "$output"
