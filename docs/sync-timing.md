# Sync timing and load

The sync engine now coalesces writes from the first trigger rather than restarting a trailing timer on every trigger. A later trigger cannot delay an existing deadline. This bounds continuous-writing delays while retaining batching. Requests remain serialized, writes arriving during a request get a follow-up, and queued changes retain the existing HLC acknowledgement protection. HTTP sync attempts time out after 15 seconds. Failed attempts back off from 2 to 60 seconds, including under continuing edits. Returning online or to a visible tab resets the retry deadline. Hidden tabs default to a 15-second poll interval; visible tabs default to 2 seconds. Polling deadlines can send writes before their debounce expires.

GitHub login `pclk` is the admin (case insensitive), based on the authenticated signed session, not client input. Only this admin can PUT global sync timing settings. Browser session, CSRF origin and bearer-token separation checks remain in force. Values are integer milliseconds from 100 through 10000; the default is 400. The setting persists in Postgres and applies to new clients within approximately a minute while online, via a separate configuration GET. No existing auth admission rules were broadened.

Settings exposes four global integer millisecond controls:

| Control | Default | Range | Effect |
| --- | ---: | ---: | --- |
| Send delay | 400 | 100–10000 | Coalesces local edits before upload |
| Visible receive interval | 2000 | 100–30000 | Checks for remote edits after each completed sync |
| Hidden receive interval | 15000 | 1000–120000 | Checks while the browser keeps a hidden tab running |
| Initial retry delay | 2000 | 250–30000 | Initial failure backoff, doubling up to 60000 ms |

The fast preset fills in 100 / 250 / 2000 / 500 ms respectively; the default preset restores the values above. Presets require saving. Saving immediately updates the current tab and advances an existing poll when appropriate, without postponing queued writes or bypassing failure backoff. Other online devices refresh within about a minute or on returning to the tab. Partial API updates preserve unspecified settings, including when an older client saves only debounce. Additive schema migrations retain existing debounce values.

The receiving device's poll interval often dominates perceived latency: lowering only the sender's debounce cannot remove the wait for the receiver. End-to-end latency includes the sender's send delay, upload and server processing, the receiver's next poll, and its response time. Lower polling intervals increase requests, battery use and data use even without edits. Browsers may throttle or suspend hidden tabs, and a locked iPad or sleeping Mac may stop syncing entirely.

Settings shows actual sync request counts and local requestSync triggers from this tab's last five minutes. Triggers include events and presence, not just unique notebook edits. The trace is in memory, capped at 10,000 entries. No notebook content is included. Counts are not measurements of end-to-end latency, database cost or fleet traffic. Configuration refresh adds about one GET per minute per active tab plus settings-page reads.

## Further optimization options

1. Add server-side request duration, response bytes, query timing and rows-read/written instrumentation. Aggregate by operation without notebook contents. This supplies measured database/compute evidence before attempting cost estimates; timing alone still does not equal billed compute.
2. Use a small realtime change notification to wake pull requests, with slower polling as recovery. This can improve remote-edit latency and reduce empty pulls, but introduces connections, notification traffic and reconnect complexity. Measure on real two-device traces first.
3. Adapt idle polling to recent remote activity, retaining immediate local pushes and wake on visibility/online. This reduces quiet-tab traffic at the expense of remote edit detection latency. Avoid changing the poll interval implicitly with the admin debounce.
4. Coordinate visible tabs with BroadcastChannel or an elected leader. This can avoid duplicate empty polling on one device. Leadership failover and per-tab IndexedDB lifecycle need explicit tests.
5. Bound batches by encoded bytes as well as entity count. Large embedded images can exceed a body limit even below 100 entities; a separate binary asset model would reduce repeated entity transfer. This needs a storage contract change, not just a shorter timer.
6. Fix the existing server sequence commit-order gap before broad multi-user concurrency: concurrent transactions can allocate sequence numbers before commit, letting a cursor pass a late-committing row. Use a transactionally ordered change log or another proven cursor protocol; lowering debounce does not fix it.

No live production database was changed during development. Tests use PGlite and fake timers. Browser multi-device latency and actual cloud load still need measurement.
