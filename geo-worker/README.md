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
