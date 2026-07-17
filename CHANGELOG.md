# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-17

First release. Wraps the background execution capability added to the Gemini
Interactions API on [2026-07-07](https://blog.google/innovation-and-ai/technology/developers-tools/expanding-managed-agents-gemini-api/).

### Added

- `gemi research "<prompt>"` — submits with `background: true` and exits immediately.
  Reads the prompt from an argument, from `--file`, or from stdin via `-`.
  Supports `--model`, `--system`, `--tag`, `--watch` and `--json`.
- `gemi status <id>` — polls the API and prints the current state.
- `gemi get <id>` — prints the result if complete, otherwise the current status.
  Completed results are served from SQLite without a network call. `--raw` dumps
  the raw interaction JSON.
- `gemi list` — all tasks, newest first. Filters: `--status`, `--tag`, `-n`.
- `gemi watch <id>` — polls until the task finishes, then prints the result.
  `--interval` tunes the poll rate. Status chatter goes to stderr so the result
  can be redirected cleanly.
- `gemi sync` — refreshes every in-flight task in one pass, four polls at a time.
- `gemi daemon` — polls in-flight tasks on a loop (default every 300s) so results
  are cached locally before the free tier drops them at 24h. `--exit-when-idle`
  stops once nothing is left in flight; `--json` emits newline-delimited events.
  Results are committed to SQLite as each poll lands, so an abrupt kill loses
  nothing already collected.
- Request pacing: every API call is held to `GEMI_RPM` requests/minute (default
  15, the free-tier allowance; `0` disables). Capping concurrency alone does not
  cap a rate, which a wide `sync` would otherwise discover the hard way.
- Retries: transient failures (429, 408, 5xx, network errors) get
  `GEMI_MAX_RETRIES` further attempts (default 4) with exponential backoff and
  full jitter, honouring `Retry-After`. A 4xx is surfaced immediately — it will
  fail identically forever, and retrying it only burns the rate limit.
- `gemi cancel <id>` — asks the API to stop an in-flight task.
- `gemi rm <ids...>` — forgets tasks locally; `--remote` also deletes them server-side.
- `gemi prune` — drops finished tasks older than `--days` (default 30). Never
  touches in-flight work. `--dry-run` shows what would go.
- `gemi stats` — where the store lives and what's in it.
- Task IDs are 8-character UUID prefixes, and any unique prefix resolves.
- Token usage is recorded per task when the API reports it.
- Colour output on a TTY, honouring `NO_COLOR`.
- Schema migrations: a v1 `tasks.db` upgrades in place without losing rows.
- Offline test suite covering every command against a mock Interactions API.
  No key or network required.

### Notes

Two details in the API differ from what a first reading of the announcement
suggests, and both are handled here:

- The API key must be sent as `x-goog-api-key`. `Authorization: Bearer <key>`
  is rejected with `401 ACCESS_TOKEN_TYPE_UNSUPPORTED`.
- The prompt field is `input` (which accepts a plain string), not `contents`.

Free-tier interactions are retained server-side for 24 hours. Once `gemi` has
seen a task complete, the text is cached locally and survives that expiry — but
something has to poll inside that window for it to be seen at all, which is what
`gemi daemon` exists to do.

[Unreleased]: https://github.com/Booyaka101/gemi-research-daemon/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Booyaka101/gemi-research-daemon/releases/tag/v0.1.0
