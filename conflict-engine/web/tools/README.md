# Browser checks

Two things this project's other tests structurally cannot catch, because both
failures only exist inside a browser.

## `cors-check.html`

A real cross-origin request from a real browser to the deployed API.

This exists because of a bug that every other check passed. The Lambda function
URL's CORS config and our handler both set `Access-Control-Allow-Origin`, and the
two were merged into `*,https://…` — not a valid origin, so browsers refused the
response. `curl` was fine. The SDK suite was fine. The preflight was fine, since
a function URL answers `OPTIONS` itself without invoking the handler. The only
symptom was the primary button on the site failing with a bare "network error".

Run it from any local server — the point is that `localhost` is a different
origin to the Lambda URL, so the browser performs the full preflight:

```bash
cd web/tools && npx serve . -l 4340    # or any static server
# open http://localhost:4340/cors-check.html
```

Checks a simple GET, two preflight-triggering POSTs (JSON body, and a bearer
token), and the NDJSON stream.

## `interactive-check.html`

Drives the built page in an iframe: disclosures open, the scroll-spy highlights
the right nav link, the progress bar advances, the theme toggle flips.

Copy it into `web/out/` after a build so it is same-origin with the page, then
open it. It caught the reading line being too low — a short section handed the
nav highlight to its successor while the reader was still inside it.

**Headless caveat.** Under `--virtual-time-budget` the compositor does not tick,
so real scroll events are never delivered and everything appears frozen at the
first measurement. The harness dispatches `new Event("scroll")` by hand after
each `scrollTo` for that reason. If you are debugging a scroll bug, confirm it in
a real browser window before believing the harness.
