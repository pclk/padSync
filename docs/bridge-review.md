# Bridge review

Checked installed Claude Code 2.1.311 (`claude --help`), codex-cli 0.169.0 (`codex exec --help`, `codex --help`), local `man launchctl`, and Next's installed route-handler guide. No paid prompts were run.

| Claim | Verdict | Evidence |
|---|---|---|
| Claude -p, --output-format stream-json, --verbose, --allowedTools Read and variadic --disallowedTools exist | Correct | Installed help lists each; trailing disallowed tool arguments are values, not a prompt. |
| Claude consumes stdin; verbose is required for stream-json print mode | Correct for captured version; not freshly executed | Existing captured fixtures and CLI tests; https://code.claude.com/docs/en/cli-reference documents print, streaming and piped input. |
| allowedTools Read makes Claude Read-only | Wrong | CLI reference distinguishes permission grants from --tools, which restricts built-ins. Added --tools Read and --strict-mcp-config. This still is not filesystem isolation. |
| Codex exec --json --skip-git-repo-check --sandbox read-only --output-last-message final.md [--image section.png] | Correct | Installed exec help lists all flags, describes JSONL, non-repository execution, command sandbox, final-message file, and variadic image files. Omitted PROMPT explicitly reads stdin. |
| Codex read-only confines all capabilities | Wrong | Help scopes sandbox to model-generated shell commands; MCP and host integrations are not covered by that claim. |
| Codex item.completed error is a warning; turn.failed and top-level error are fatal | Correct | https://github.com/openai/codex/blob/main/sdk/typescript/src/items.ts and https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts distinguish nonfatal error items from thread errors. Existing fixtures exercise parsing. |
| Tokens have 256 random bits and only hashes persist | Correct | randomBytes(32), SHA-256, explicit list projection; new four-character hint test. Database lookup is not constant-time, but digest lookup does not expose a useful plaintext prefix oracle. |
| Every bearer request is disjoint from sessions | Wrong before fixes | Malformed Bearer headers fell through; Canvas returned 401 instead of required 403. Regression tests added. |
| Revocation stops a running bridge | Wrong before fix | Progress 401 was logged and ignored until the agent completed. New process test revokes during HANG and requires exit 2. Already-authorized requests can still finish after revocation. |
| Claim/state writes are atomic with Neon HTTP | Correct | Each mutation is one statement; SKIP LOCKED subquery belongs to the UPDATE transaction. Diagnostic SELECT after failed update can observe a later state but does not grant writes. |
| Two bridges can never execute the same job | Wrong | Partitioned live workers can be reclaimed. Updated comments. Device ID fencing blocks a different device, but does not distinguish two processes using the same token. |
| Output is capped | Correct in SQL; wrong in bridge before fix | left(...,$7) accepts the integer bound. API rejects oversized replacements before SQL. Bridge now caps replacements before sending. |
| Heartbeats imply only dead agents are reclaimed | Wrong | Network outages also prevent heartbeats. Updated comment. |
| Tokens never leak | Unverified as an absolute guarantee | Header transport, redirect:error, masked normal logs and mode 600 are sound. Agent environment inherits PADSYNC_TOKEN; echoed errors/question text could contain credentials. |
| CSRF fully prevented | Unverified | SameSite=Lax helps against cross-site POST, but no Origin validation; same-site hostile origins remain a concern. |
| launchctl bootstrap/bootout gui/uid plist syntax | Correct | Installed man page accepts domain target plus service paths. GUI domain requires logged-in session. |
| Installation always works and revocation leaves daemon stopped | Wrong | Parent LaunchAgents/Logs directories are not created; KeepAlive=true restarts exit 2 every throttle interval. Generated XML escaping and ProgramArguments are covered by existing tests. Actual installation not performed. |

Recommendations left unimplemented, highest priority first:

1. Isolate agent credentials/environment and filesystem; remove PADSYNC_TOKEN from children. Read access can expose bridge.json or other private files. Restrict MCP, hooks and ambient configuration for both agents. Installed Claude has --safe-mode and --permission-mode dontAsk; installed Codex has --ignore-user-config, --ignore-rules and --ephemeral. Verify compatibility with intended account configuration before adopting them.
2. Introduce a unique claim lease per execution, including when multiple bridge processes share one device token. Test locking against multi-connection Postgres: PGlite concurrent promises serialize internally and do not prove SKIP LOCKED behavior under real contention.
3. Redact token-shaped strings in all logs and error paths; avoid logging question text. Add explicit same-origin checks to cookie-authenticated mutations.
4. Create launchd parent directories and configure KeepAlive to avoid restarting on permanent authentication failure. Test plist with plutil and a disposable macOS user rather than installing into the current account.
5. Bound runner memory and stderr/JSONL parsing defensively; API output truncation does not bound accumulated stdout. Add adversarial malformed stream tests and Unicode cap tests.

Coverage added: 30 state/action combinations, three malformed Authorization variants, Canvas bearer rejection, token hint projection, bridge output truncation, running-job revocation, ownership loss/409, network backoff/recovery and token absence from those logs. Existing coverage includes concurrent claims, stale reclaim, heartbeat freshness, normal 401 exit and parser fixtures. This review does not certify hostile MCP/config behavior, real multi-connection locking, or launchd installation.

## Addressed after review

- Recommendation 1 (partly): agents no longer inherit `PADSYNC_*` variables (`agentEnv`, test in
  `tests/review.test.ts`). Filesystem isolation and `--safe-mode` / `--ignore-user-config` are still open.
- Recommendation 3 (partly): session endpoints refuse non-GET requests whose `Origin` is another
  site (`requireSession`, tested). Log redaction is still open.
- Recommendation 4 (partly): `install` creates `~/Library/LaunchAgents` and `~/Library/Logs` first.
  KeepAlive restarts after a revoked token remain (one rejected request per 30 s).
