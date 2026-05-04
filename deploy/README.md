# Deployment Notes

This folder contains a production-shaped MVP deployment example for GEO Ops.

For the current target server `47.239.166.249`, see `docs/server-47.239.166.249-deployment.md`.

Before running it:

1. Copy `.env.example` to `.env` at the repository root.
2. Replace all placeholder secrets and domains.
3. Set `GEO_OPS_AUTH_ENABLED=true` and choose a strong `GEO_OPS_ADMIN_PASSWORD`.
4. For this Compose file, set `DATABASE_URL` to use host `postgres`, not `localhost`.
5. Edit `deploy/Caddyfile.example` for the real GEO Ops domain and SSL mode.
6. Make sure DNS points that domain to the Linux server or to a Cloudflare proxied record.
7. Open only ports `80` and `443` on the server firewall.

The current `wingheng.technology` test deployment uses Cloudflare edge HTTPS with HTTP origin mode to avoid redirect loops under Cloudflare `Flexible`. For production, prefer Cloudflare `Full (strict)` plus an HTTPS Caddy site block.

Run:

```bash
docker compose -f deploy/docker-compose.prod.example.yml build
docker compose -f deploy/docker-compose.prod.example.yml up -d postgres
docker compose -f deploy/docker-compose.prod.example.yml run --rm geo-ops npm run prisma:deploy
docker compose -f deploy/docker-compose.prod.example.yml up -d
```

Optional Redis service:

```bash
docker compose -f deploy/docker-compose.prod.example.yml --profile optional-cache up -d redis
```

The included PostgreSQL service is suitable for MVP validation. For production, prefer a managed PostgreSQL service with automatic backups and PITR.
