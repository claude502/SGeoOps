param(
  [string]$HostName = "47.239.166.249",
  [string]$User = "root",
  [string]$KeyPath = "$env:USERPROFILE\.ssh\geo_ops_deploy_ed25519",
  [string]$RemoteDir = "/opt/geo-content-ops",
  [switch]$UseIpCaddy,
  [switch]$RunMigrations
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$archive = Join-Path $env:TEMP "geo-content-ops-deploy.tar.gz"
$remote = "${User}@${HostName}"

if (!(Test-Path $KeyPath)) {
  throw "SSH key not found: $KeyPath"
}

Push-Location $repoRoot
try {
  if (Test-Path $archive) {
    Remove-Item -LiteralPath $archive -Force
  }

  tar `
    --exclude=".git" `
    --exclude="node_modules" `
    --exclude=".next" `
    --exclude=".env" `
    --exclude=".env.local" `
    --exclude=".secrets" `
    --exclude="secrets/" `
    --exclude=".credentials" `
    --exclude="docs/*.local.md" `
    --exclude="*.tsbuildinfo" `
    --exclude="dev-server.*.log" `
    --exclude="qa-*.png" `
    --exclude=".chrome-qa-profile" `
    -czf $archive .

  ssh -i $KeyPath $remote "mkdir -p $RemoteDir"
  scp -i $KeyPath $archive "${remote}:/tmp/geo-content-ops-deploy.tar.gz"
  ssh -i $KeyPath $remote "tar -xzf /tmp/geo-content-ops-deploy.tar.gz -C $RemoteDir && rm /tmp/geo-content-ops-deploy.tar.gz"

  $remoteCommands = @(
    "cd $RemoteDir",
    "test -f .env || (echo 'Missing $RemoteDir/.env. Create it from .env.example before starting services.' && exit 20)",
    "install -d -m 700 secrets",
    "test -f secrets/sgeo_internal_secret || (echo 'Missing $RemoteDir/secrets/sgeo_internal_secret. Provision it separately over SSH or your secret manager, then chmod 600 it.' && exit 21)",
    "chmod 600 secrets/sgeo_internal_secret",
    $(if ($UseIpCaddy) { "cp deploy/Caddyfile.ip.example deploy/Caddyfile.example" } else { "true" }),
    "docker compose --env-file .env -f deploy/docker-compose.prod.example.yml build",
    "docker compose --env-file .env -f deploy/docker-compose.prod.example.yml up -d postgres"
  )

  if ($RunMigrations) {
    $remoteCommands += "docker compose --env-file .env -f deploy/docker-compose.prod.example.yml run --rm geo-ops npm run prisma:deploy"
  }

  $remoteCommands += "docker compose --env-file .env -f deploy/docker-compose.prod.example.yml up -d"
  $remoteCommands += "docker compose --env-file .env -f deploy/docker-compose.prod.example.yml ps"

  ssh -i $KeyPath $remote ($remoteCommands -join " && ")
}
finally {
  Pop-Location
}
