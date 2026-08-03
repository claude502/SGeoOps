# GEO Worker

## SiteOne egress boundary

The SiteOne task resolves and pins the requested public DNS origin, then passes an
exact-origin `--include-regex` to the crawler. Those checks reduce DNS rebinding,
redirect, and related-domain egress risk, but they are not a network policy.
Production deployment must also enforce outbound network controls that permit only
approved public crawl destinations and the SGeoOps internal endpoint. The worker
does not use a database connection.

## Search Console dispatch contract

`search-console-daily-dispatch` registers the daily `0 4 * * *` Trigger schedule.
It sends the scheduled timestamp to the signed SGeoOps dispatch endpoint, which
creates or reuses one owned run per enabled Search Console integration for the
final Pacific data date. The worker validates the returned payloads and starts
`search-console-sync` with one idempotent batch trigger. Both tasks remain
database-free. Their payloads contain only run/integration scope; the sync task
obtains the OAuth token through the signed credential endpoint at execution time.

## Matomo reporting contract

`matomo-sync` accepts only bounded run/client/brand/site/integration identifiers,
a canonical HTTP(S) Matomo origin, a maximum 366-day range, an IANA timezone,
bounded `idSite`/`idGoal`, the original segment, and a configured `goalName`.
The Trigger payload never contains `token_auth`. At runtime the task obtains the
token through the signed SGeoOps credential route and sends it only in the Matomo
Reporting API POST body.

The adapter calls `Actions.getPageUrls` for page views, the same report with the
`referrerType==search` segment for organic visits, and `Goals.get` for the selected
goal. It accepts only local page paths, stores the three exact provider responses
in the framed `application/vnd.sgeo.matomo-reports.v1` artifact, uploads that
artifact before checkpoint/ingest, and keeps only the normalized envelope in
Trigger metadata. Authentication failure is checkpointed before SGeoOps disables
the exact owned integration. SGeoOps remains the only business database writer.

Production Trigger tasks and the production worker are not deployed by this
Compose work. Their self-hosted deployment remains a Phase 2 Task 9 precondition.
