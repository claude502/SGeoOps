#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf 'artifact backup: %s\n' "$*" >&2
  exit 1
}

app_dir=${APP_DIR:-/opt/geo-content-ops}
compose_file=${ARTIFACT_COMPOSE_FILE:-deploy/docker-compose.prod.example.yml}
env_file=${ARTIFACT_ENV_FILE:-.env}
backup_dir=${SGEO_ARTIFACT_BACKUP_DIR:-}
artifact_root=${SGEO_ARTIFACT_ROOT:-/var/lib/sgeo/artifacts}
retention_days=${ARTIFACT_BACKUP_RETENTION_DAYS:-14}

[[ -n "$backup_dir" ]] || fail "SGEO_ARTIFACT_BACKUP_DIR is required"
[[ "$backup_dir" = /* ]] || fail "SGEO_ARTIFACT_BACKUP_DIR must be an absolute path"
[[ "$artifact_root" = /* ]] || fail "SGEO_ARTIFACT_ROOT must be an absolute path"
[[ "$retention_days" =~ ^[0-9]+$ ]] || fail "ARTIFACT_BACKUP_RETENTION_DAYS must be a non-negative integer"
[[ -d "$app_dir" ]] || fail "APP_DIR does not exist: $app_dir"

case "$artifact_root" in
  *$'\n'* | .. | ../* | */.. | */../*) fail "SGEO_ARTIFACT_ROOT contains an unsafe path segment" ;;
esac

backup_dir=${backup_dir%/}
artifact_root=${artifact_root%/}
[[ -n "$backup_dir" ]] || fail "SGEO_ARTIFACT_BACKUP_DIR must not be the filesystem root"
[[ -n "$artifact_root" ]] || fail "SGEO_ARTIFACT_ROOT must not be the filesystem root"

cd "$app_dir"
[[ -f "$compose_file" ]] || fail "compose file not found: $compose_file"
[[ -f "$env_file" ]] || fail "environment file not found: $env_file"
command -v docker >/dev/null || fail "docker is required"
docker info >/dev/null 2>&1 || fail "docker daemon is unavailable"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"

compose=(docker compose --env-file "$env_file" -f "$compose_file")
"${compose[@]}" config --services | grep -Fxq geo-ops || fail "geo-ops is not configured"
"${compose[@]}" ps --status running --services | grep -Fxq geo-ops || fail "geo-ops is not running"

install -d -m 0700 "$backup_dir"
[[ ! -L "$backup_dir" ]] || fail "SGEO_ARTIFACT_BACKUP_DIR must not be a symlink"
backup_dir=$(cd "$backup_dir" && pwd -P)

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive_name="sgeo-artifacts-${timestamp}.tar.gz"
archive_path="$backup_dir/$archive_name"
temporary_path=$(mktemp "$backup_dir/.${archive_name}.XXXXXX")

cleanup() {
  rm -f "$temporary_path"
}
trap cleanup EXIT

read -r -d '' archive_command <<'SH' || true
set -eu
umask 077
case "$SGEO_ARTIFACT_ROOT" in
  /*) : ;;
  *) exit 64 ;;
esac
test -d "$SGEO_ARTIFACT_ROOT"
test ! -L "$SGEO_ARTIFACT_ROOT"
cd "$SGEO_ARTIFACT_ROOT"
tar -czf - .
SH

"${compose[@]}" exec -T -e "SGEO_ARTIFACT_ROOT=$artifact_root" geo-ops sh -ec "$archive_command" > "$temporary_path"
[[ -s "$temporary_path" ]] || fail "geo-ops produced an empty archive"
gzip -t "$temporary_path"
tar -tzf "$temporary_path" | while IFS= read -r entry; do
  case "$entry" in
    /* | ../* | */../*) fail "archive contains an unsafe entry: $entry" ;;
  esac
done

chmod 0600 "$temporary_path"
mv -f "$temporary_path" "$archive_path"
find "$backup_dir" -maxdepth 1 -type f -name 'sgeo-artifacts-*.tar.gz' -mtime "+$retention_days" -delete
trap - EXIT

printf '%s\n' "$archive_path"
