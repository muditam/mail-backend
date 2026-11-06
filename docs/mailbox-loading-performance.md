# Mailbox loading performance

The `perf/mailbox-loading` branch is based on production `mongo-imp` and excludes the account-administration feature. No frontend API contract or environment variable changes are needed.

## Changes

- A populated folder list previously made three sequential JMAP operations (validate folder, query IDs, retrieve summaries), each with separate discovery and token validation. It now uses one discovery and one JMAP POST containing the three calls. `Email/get` references the query's IDs using JMAP result references.
- Pagination still queries `limit + 1` IDs. The batch fetches those summaries, but exposes only `limit` messages and the existing cursor. It never fetches message bodies for listing. Empty results include an empty metadata fetch in the same batch.
- Each request still validates its session and password-onboarding policy. Token validation retains its pre/post-renewal session checks and account discovery check. There is no cross-request authorization cache.
- Registered OAuth grants are read directly rather than re-registered on every access. Legacy grants without a reference are registered once. Missing referenced grants fail closed and cannot be recreated from stale snapshots. Retention is extended only if a consumer needs a later deadline.
- With idle expiry disabled, session lookups read the session instead of updating `touchedAt`. With idle expiry enabled, the existing conditional atomic touch remains. Absolute deadlines and authorization checks remain independent of MongoDB TTL cleanup.

For an already-registered, valid-token request listing a populated folder, the normal path drops from about 21 MongoDB operations to 8, and from 6 Stalwart HTTP requests to 2. No production latency promise follows from those counts: network location and provider/database processing still matter. Initial frontend loading still restores the session before folders and then messages; this change shortens those requests rather than changing that UI sequence.

## Timings

Responses include `Server-Timing` with milliseconds for available stages. Structured `request_timings` log events contain the same stage durations and invocation counts, correlated by the existing request ID. Names contain no credentials, subjects, recipient addresses or raw session IDs.

- `session`: initial request session validation.
- `session_db`: all session reads/touches, including renewal safeguards.
- `policy_db`: password-onboarding policy reads.
- `token`: token resolution and pre/post session safeguards.
- `oauth`: shared credential coordination.
- `credential_db`: shared credential reads (multiple reads can indicate waiting for another refresher).
- `upstream_refresh`: actual provider refresh calls, when needed.
- `discovery`: JMAP session discovery.
- `jmap`: HTTP fetch through receipt of response headers.
- `jmap_decode`: JMAP response-body transfer/JSON decoding.
- `retry_summaries`: delivery-retry summary lookup.

Some stages nest inside others; do not sum all stage values. Fastify's existing `request completed` event provides total request duration. Timings are request-local, including concurrent requests and failures.

## Validation and rollout

Run `npm test` and `npm run build`. Loading coverage checks the single-batch wire format, query ordering/cursors, no credential writes on the valid-token path, missing folders, provider errors, account mismatch, missing credential references and timing isolation. Existing session tests cover the fixed 30-day deadline, CSRF, independent devices, concurrent browser/worker renewal, refresh failures, logout during renewal and uncertain refresh leases.

After deployment, compare the same warm folder load in browser Network tools and correlate its `Server-Timing` with Heroku request logs. Check normal loads and an access-token renewal. Keep security settings unchanged. A combined frontend bootstrap endpoint or bounded discovery cache is a separate possible follow-up; neither is required for this patch and neither is introduced here.
