# GEO Worker

## SiteOne egress boundary

The SiteOne task resolves and pins the requested public DNS origin, then passes an
exact-origin `--include-regex` to the crawler. Those checks reduce DNS rebinding,
redirect, and related-domain egress risk, but they are not a network policy.
Production deployment must also enforce outbound network controls that permit only
approved public crawl destinations and the SGeoOps internal endpoint. The worker
does not use a database connection.
