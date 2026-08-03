# Trigger.dev v4 Production Runbook

SGeoOps production tasks run on a separately provisioned Trigger.dev v4.5.9 platform.
The SGeoOps Compose stack does not start Trigger workers. Trigger task containers call the
signed SGeoOps internal API and must never receive `DATABASE_URL`, a PostgreSQL credential,
or a provider token.

## 1. Provision The Trigger Platform

Use a dedicated Linux host or worker pool. Keep the Trigger webapp and its Postgres, Redis,
ClickHouse, registry, and object storage separate from SGeoOps. Use the official Trigger.dev
v4 Docker deployment layout, pin every Trigger image to `v4.5.9`, and use the same `4.5.9`
CLI version as `geo-worker/package.json`.

```bash
git clone --depth=1 https://github.com/triggerdotdev/trigger.dev.git /opt/trigger-dev
cd /opt/trigger-dev/hosting/docker
cp .env.example .env
printf '\nTRIGGER_IMAGE_TAG=v4.5.9\n' >> .env

docker compose --env-file .env -f webapp/docker-compose.yml config --quiet
docker compose --env-file .env -f worker/docker-compose.yml config --quiet
docker compose --env-file .env -f webapp/docker-compose.yml up -d
```

For a split deployment, obtain the generated worker token from the first webapp startup,
store it as a secret, set `TRIGGER_WORKER_TOKEN` on the worker host, then start one or more
workers:

```bash
cd /opt/trigger-dev/hosting/docker/worker
docker compose --env-file ../.env up -d
docker compose --env-file ../.env ps
```

Expose only the Trigger webapp through authenticated HTTPS. Keep the worker supervisor,
registry, database, cache, object store, and Docker socket proxy on private networks. The
runner network must have HTTPS egress to `SGEO_INTERNAL_URL` and to the audited public sites;
do not attach it to the SGeoOps database network.

## 2. Configure The Task Project

Copy [trigger.env.example](../trigger.env.example) to the deployment secret store. Add
`SGEO_INTERNAL_URL` and `PUPPETEER_EXECUTABLE_PATH` to the Trigger project production
environment. Add `SGEO_INTERNAL_SECRET` there as a Trigger **Secret**. It is used only to
sign SGeoOps requests and is not placed in task payloads, metadata, logs, or artifacts.

The worker supports a read-only `SGEO_INTERNAL_SECRET_FILE` mount for local and specially
provisioned runtimes. Standard self-hosted Docker runners do not mount arbitrary host paths
into each task container, so use the Trigger Secret environment variable unless a mount has
been explicitly verified. A configured but unreadable secret file fails closed and never
falls back to the environment variable.

Before deploying, confirm the effective task environment has no `DATABASE_URL`,
`TRIGGER_DATABASE_URL`, direct SGeoOps database credentials, or third-party provider tokens.
Google Search Console and Matomo credentials are retrieved only by the signed, scope-bound
SGeoOps control-plane endpoints at run time.

## 3. Deploy And Verify

Run the deploy from a CI runner with Docker Buildx and access to the Trigger registry. Supply
`TRIGGER_API_URL` and `TRIGGER_ACCESS_TOKEN` through CI secrets. Do not run `trigger dev` in
production.

```bash
cd /path/to/geo-content-ops
npm ci
npm --workspace geo-worker run typecheck
npm --workspace geo-worker run trigger:deploy:dry

export TRIGGER_API_URL=https://trigger.example.internal
export TRIGGER_ACCESS_TOKEN=<ci-secret>
export TRIGGER_PROJECT_REF=proj_sgeo_ops
(cd geo-worker && npx trigger.dev@4.5.9 deploy --env prod)
```

After promotion, start one controlled SiteOne or Unlighthouse run for a non-production test
site. Verify the Trigger run finishes, the SGeoOps run reaches `succeeded` or `partial`, its
raw artifact is readable through the platform, and the SEO report shows version `seo-v1` with
evidence-backed recommendations. Rotate `SGEO_INTERNAL_SECRET` by adding the replacement
secret to both the SGeoOps secret file and Trigger project, deploying, verifying one run, and
then removing the previous value according to the platform secret-rotation procedure.

## 4. Operations

Use the Trigger dashboard and supervisor logs for task-run diagnosis. Treat task logs,
metadata, raw artifacts, and CI output as non-secret channels. Pause Trigger schedules before
SGeoOps database or artifact recovery, complete recovery using the SGeoOps procedure, then
run one controlled audit before resuming schedules.

Trigger self-hosting is an independently operated control plane. Its upgrades require a
staging deployment and a matching CLI/image version change; do not use floating `latest`
images in production.
