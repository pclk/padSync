# Sync timing and load

The sync engine now coalesces writes from the first trigger rather than restarting a trailing timer on every trigger. A later trigger cannot delay an existing deadline. This bounds continuous-writing delays while retaining batching. Requests remain serialized, writes arriving during a request get a follow-up, and queued changes retain the existing HLC acknowledgement protection. HTTP sync attempts time out after 15 seconds. Failed attempts back off from 2 to 60 seconds, including under continuing edits. Returning online or to a visible tab resets the retry deadline. Hidden tabs default to a 60-second poll interval; visible tabs default to 2 seconds. Polling deadlines can send writes before their debounce expires.

GitHub login `pclk` is the admin (case insensitive), based on the authenticated signed session, not client input. Only this admin can PUT global sync timing settings. Browser session, CSRF origin and bearer-token separation checks remain in force. Values are integer milliseconds from 0 through 10000; the default is 100. The setting persists in Postgres and applies to new clients within approximately a minute while online, via a separate configuration GET. No existing auth admission rules were broadened.

Settings exposes four global integer millisecond controls:

| Control | Default | Range | Effect |
| --- | ---: | ---: | --- |
| Send delay | 100 | 0–10000 | Coalesces local edits before upload |
| Visible receive interval | 2000 | 0–30000 | Checks for remote edits after each completed sync |
| Hidden receive interval | 60000 | 0–120000 | Checks while the browser keeps a hidden tab running |
| Initial retry delay | 2000 | 0–30000 | Initial failure backoff, doubling up to 60000 ms |

The fast preset fills in 50 / 2000 / 60000 / 2000 ms respectively; the default preset restores the values above. Presets require saving. Saving immediately updates the current tab and advances an existing poll when appropriate, without postponing queued writes or bypassing failure backoff. Other online devices refresh within about a minute or on returning to the tab. Partial API updates preserve unspecified settings, including when an older client saves only debounce. Additive schema migrations retain existing debounce values.

The receiving device's poll interval often dominates perceived latency: lowering only the sender's debounce cannot remove the wait for the receiver. End-to-end latency includes the sender's send delay, upload and server processing, the receiver's next poll, and its response time. Lower polling intervals increase requests, battery use and data use even without edits. Browsers may throttle or suspend hidden tabs, and a locked iPad or sleeping Mac may stop syncing entirely.

Settings shows actual sync request counts and local requestSync triggers from this tab's last five minutes. Triggers include events and presence, not just unique notebook edits. The trace is in memory, capped at 10,000 entries. No notebook content is included. Counts are not measurements of end-to-end latency, database cost or fleet traffic. Configuration refresh adds about one GET per minute per active tab plus settings-page reads.

## Further optimization options

1. Add server-side request duration, response bytes, query timing and rows-read/written instrumentation. Aggregate by operation without notebook contents. This supplies measured database/compute evidence before attempting cost estimates; timing alone still does not equal billed compute.
2. Measure notification latency on real two-device traces and coordinate duplicate browser tabs before tuning intervals further.
3. Adapt idle polling to recent remote activity, retaining immediate local pushes and wake on visibility/online. This reduces quiet-tab traffic at the expense of remote edit detection latency. Avoid changing the poll interval implicitly with the admin debounce.
4. Coordinate visible tabs with BroadcastChannel or an elected leader. This can avoid duplicate empty polling on one device. Leadership failover and per-tab IndexedDB lifecycle need explicit tests.
5. Bound batches by encoded bytes as well as entity count. Large embedded images can exceed a body limit even below 100 entities; a separate binary asset model would reduce repeated entity transfer. This needs a storage contract change, not just a shorter timer.
6. Any future writer of `entities` must acquire the same transaction-scoped advisory lock before allocating sequence numbers. Bypassing the sync endpoint would otherwise reintroduce out-of-order commits.

Tests use PGlite and fake timers. Neon Realtime was enabled on the selected project and the metadata subscription was verified against the live branch without writing notebook data. Browser multi-device latency and actual cloud load still need measurement.

All timing controls accept zero: sending and retrying have no intentional delay, and zero receive intervals start the next serialized request as soon as the previous one completes. Browser timer throttling still applies. Positive retry delays double on repeated failures; zero stays zero. Existing database constraints are migrated to accept zero without changing saved values. The request-count replay returns Infinity for zero polling because response duration is not modeled.

## Realtime notifications

`POST /api/sync/live` uses the existing GitHub session and CSRF guard. It seals only
`SELECT id, seq FROM entities ORDER BY seq DESC LIMIT 1`, not notebook content. This app currently
admits one configured GitHub account and shares its notebooks across devices; this query does not
introduce per-notebook or multi-user authorization. Missing realtime configuration returns a disabled
response; provider failures preserve HTTP polling. The secret remains server-only. Capabilities are
short-lived bearer credentials, returned with `Cache-Control: no-store` and held only in memory.

The client subscribes directly to Neon and renews about ten seconds before capability expiry.
Initial results, changed metadata and reconnection to a live state trigger `requestSync(0)`.
The notification sequence never advances the HTTP cursor. Notifications from this device are
accepted too; they can produce one extra empty pull, avoiding unsafe user-level suppression that
would also silence the other device. Requests remain serialized. While realtime is live, the
poll interval is `max(configured interval, 30000)`. Notification pulls and local writes can run sooner.
When realtime fails, the configured polling interval resumes; subscription setup retries with its
own bounded exponential delay (2–60 seconds), independent of the user-configurable HTTP retry delay.
A disabled service is checked again after a minute. Hidden/offline/page-hidden tabs close their
subscription and suspend renewals; visible/online/page-show events open a fresh connection. Signing
out stops sync and reloads the page to discard capabilities. Renewals recheck authentication.

Vercel still handles save/pull requests, configuration reads and capability minting/renewals.
The idle WebSocket lives on Neon. Neon service and database usage still apply; realtime is not
free compute, and using zero polling after a realtime outage can still generate heavy traffic.

Entity writes now acquire a transaction-scoped advisory lock in a materialized CTE before sequence
allocation. The lock remains held through statement commit, making sequence order safe for HTTP
cursors. A fresh statement reads authoritative versions after the upsert, so a conflict winner
committed while the upsert waited is returned even if it is behind the caller's cursor. No notebook
schema or payload format changes are required. Old clients use the same updated write endpoint.

### Validation

Run the focused suites with:

```sh
npx vitest run tests/sync-live.test.ts tests/sync-realtime.test.ts tests/sync-timing.test.ts tests/sync-config.test.ts tests/sweep-server.test.ts --maxWorkers=1
```

For true concurrent transactions, point `PADSYNC_TEST_POSTGRES_URL` at a disposable local PostgreSQL
server and run `npx vitest run tests/sync-concurrency.postgres.test.ts`. The suite rejects remote
hosts, creates an isolated schema, and drops that schema afterward. It verifies that a blocked
writer does not allocate a sequence before its predecessor commits, and that a concurrent conflict
winner is returned even when normal cursor pulls exclude it. Without that variable the suite skips.

The fast preset retains moderate outage polling and failure retry intervals; only the local send window is shorter than the default. Existing saved configuration is preserved when code defaults change.
