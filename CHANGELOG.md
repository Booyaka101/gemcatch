# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-08-08

### Added

- **Research agents.** `-a, --agent <id>` on `research` and `batch` submits to a
  Gemini Deep Research agent instead of a model — `interactions.create` is sent
  `agent` *instead of* `model` (they are mutually exclusive, and passing both is
  a clean error). Aliases resolve through one table: `deep-research` →
  `deep-research-preview-04-2026`, `deep-research-max` →
  `deep-research-max-preview-04-2026`; any other value passes through unchanged,
  so a future agent id works without a gemcatch release. Agents *require*
  background execution, which gemcatch has always set — and on the free tier the
  finished report is dropped after 1 day, which is exactly the race the daemon
  exists to win. The agent is recorded per task, shown in `list` (the AGENT
  column appears when a listing contains agent runs) and tallied in `stats`.
- **Spend guard.** Deep Research is documented at $1.00–$3.00 per task and Deep
  Research Max at $3.00–$7.00 (estimates based on preview rates, per the docs,
  and subject to change). Every agent submission prints its band first —
  `batch` prints N × the band as a total — and asks for an interactive `y/N`
  confirmation. When stdin is not a TTY, `--yes` is required and anything else
  is refused before a row is written; declining writes nothing and exits
  non-zero. `--dry-run` (now on `research` too) prints the full projected spend
  and submits nothing.
- **Citations.** Agent runs return citations alongside the report; the docs say
  to review them to verify the sources, so they are persisted (new `citations`
  column, JSON) rather than discarded, printed under the result as a `Sources:`
  list, and carried in `--json` output.
- Result extraction now takes the **final answer-bearing step** — where the
  docs place an agent's completed report (`steps[-1].content[0].text`) and
  where a model run's `model_output` already sits — with a fall-back to the old
  collect-everything behaviour if that step carries no text, so an unexpected
  shape can never silently blank a result. No special-casing on the agent id.
- Additive schema migration: `agent` and `citations` columns. A pre-0.4.0
  `tasks.db` upgrades in place, keeps every row, and reports `agent` as NULL
  for them.

### Changed

- The default model is now **`gemini-3.5-flash-lite`** (GA on 2026-07-21),
  replacing the older `gemini-3.1-flash-lite`. Override with `GEMCATCH_MODEL`
  or `--model` as before.

## [0.3.0] - 2026-07-19

### Added

- `gemcatch export [--tag <t>] [--status <s>] [--format md|json] [-o <file>]` —
  concatenate finished results into one document, each under a heading with its
  prompt, id and date. Markdown by default (or JSON for `jq`), to stdout or a
  file. This is the "gather" step that pairs with `batch`'s "scatter": where
  `get` prints one result at a time, `export` collects a whole tag at once.
- `gemcatch digest --tag <t>` — feed a tag's completed results back through a
  single Gemini call to synthesise one summary. Submits like `research` and
  watches to completion; the summary lands under `<tag>-digest`.
- `GEMCATCH_WATCH_MAX_FAILS` (default 10) — the consecutive-poll-failure bound
  at which `watch` and `batch -w` give up rather than loop forever.

### Fixed

- `research --watch` no longer marks a **successfully submitted, server-running**
  task `failed` when a poll errors during the watch. A transient poll failure (a
  5xx past its retries, a network blip) or an expiry mid-watch would propagate to
  the submit handler and overwrite the status to `failed`, dropping the task from
  the active set so the daemon abandoned it and the result was lost. The watch
  loop now rides out poll errors (retrying on the next interval), and only a
  failed *submit* — a task with no `interaction_id` yet — is ever marked `failed`.
- A wedged or expired interaction no longer keeps a task in flight forever. When a
  poll returns **404** (the free tier drops interactions after 24h, or one was
  deleted), the task is retired locally to `incomplete` with a recorded reason, so
  it leaves the active set and `daemon --exit-when-idle` converges. `watch` and
  `batch -w` additionally stop after `GEMCATCH_WATCH_MAX_FAILS` consecutive poll
  failures (or a stalled batch), with a clear message and a non-zero exit, instead
  of spinning.
- A **completed-but-empty** result is now served from the local cache. `get` and
  `watch` gated the cache hit on the result being truthy, so a task that completed
  with empty text (`''`) skipped the cache, re-polled, and 404'd after 24h — the
  exact loss the daemon exists to prevent. The gate is now on presence
  (`result != null`), not truthiness.
- `prune -d <negative>` (or a non-numeric `--days`) is rejected instead of putting
  the cutoff in the future and deleting **every** finished task. `--days` must now
  be a non-negative number.
- `batch` no longer silently drops a prompt line that starts with `#`. A `#` is a
  comment only when followed by whitespace (`# like this`); a line such as
  `#1 cause of X?` is a real prompt and survives. When comment or blank lines are
  skipped, a one-line count is noted on stderr.
- `watch -i` / `daemon -i` reject a non-positive interval (`-i -5` busy-looped,
  `-i 0` silently fell back to the default). `list -n 0` now returns zero rows
  instead of all of them, and `-n` rejects negatives (which SQLite reads as "no
  limit").
- A second `Ctrl-C` to the daemon now force-exits (130) instead of doing nothing
  while a long paced pass finishes.
- One-shot commands close the SQLite store on exit, so they no longer leave
  `-wal`/`-shm` sidecar files lingering next to `tasks.db`.
- Colour written to **stderr** (the status chatter from `watch`, `daemon` and
  `research -w`) is now keyed to `process.stderr.isTTY`, not stdout's. Redirecting
  one stream no longer strips colour from the other, nor leaks raw ANSI into a
  redirected file.

### Notes

- The default `@google/genai` SDK transport is now covered by the offline suite
  (previously every test forced `GEMCATCH_FORCE_REST=1`): a stubbed client drives
  submit → poll → completed and one unwrapped SDK error, confirming `shape()`
  reads an SDK-shaped response and `friendly()` surfaces Google's real message.
- `GEMCATCH_RPM` pacing is **per process**. Two concurrent `gemcatch` processes
  each keep their own counter and can together exceed the ceiling; run a single
  daemon if the limit must hold. Documented in the README.

## [0.2.0] - 2026-07-19

### Added

- `gemcatch batch <file>` — submit many background tasks from a file in one
  command. One prompt per non-empty line by default (`#` comments and blanks are
  skipped); `--separator <str>` splits the file on a delimiter line so prompts
  can span multiple lines; `-` reads the list from stdin. The whole batch is
  tagged as a unit — `-t/--tag` sets it, otherwise an auto tag `batch-<hex>` is
  generated and printed — so it is collectable with `gemcatch list --tag`.
  Submissions are bounded but concurrent (four at a time, paced by `GEMCATCH_RPM`),
  and a single failed submit is marked `failed` and reported without sinking the
  rest of the batch. Supports `-m/--model`, `-s/--system`, `--dry-run` (parse and
  list, submit nothing), `--json`, and `-w/--watch` (poll the batch to completion,
  then print a combined tally).

## [0.1.1] - 2026-07-19

### Fixed

- REST fallback (`GEMCATCH_FORCE_REST=1`, or when the SDK lacks Interactions)
  no longer prepends the echoed prompt and the model's reasoning to the result.
  A real Interactions response tags each step by type; only `model_output` is
  the answer. The default SDK path was unaffected. Verified live against the API.

### Changed

- Require Node.js 22+. The advertised "20+" was never accurate — `commander@15`
  requires Node `>=22.12`, and Node 20 reached end-of-life. CI now covers 22 and 24.
- Clarified the free-tier wording in the README: `gemini-3.1-flash-lite` is free
  within the free tier's daily quota, then billed at standard rates.

## [0.1.0] - 2026-07-17

First release. Wraps the background execution capability added to the Gemini
Interactions API on [2026-07-07](https://blog.google/innovation-and-ai/technology/developers-tools/expanding-managed-agents-gemini-api/).

### Added

- `gemcatch research "<prompt>"` — submits with `background: true` and exits immediately.
  Reads the prompt from an argument, from `--file`, or from stdin via `-`.
  Supports `--model`, `--system`, `--tag`, `--watch` and `--json`.
- `gemcatch status <id>` — polls the API and prints the current state.
- `gemcatch get <id>` — prints the result if complete, otherwise the current status.
  Completed results are served from SQLite without a network call. `--raw` dumps
  the raw interaction JSON.
- `gemcatch list` — all tasks, newest first. Filters: `--status`, `--tag`, `-n`.
- `gemcatch watch <id>` — polls until the task finishes, then prints the result.
  `--interval` tunes the poll rate. Status chatter goes to stderr so the result
  can be redirected cleanly.
- `gemcatch sync` — refreshes every in-flight task in one pass, four polls at a time.
- `gemcatch daemon` — polls in-flight tasks on a loop (default every 300s) so results
  are cached locally before the free tier drops them at 24h. `--exit-when-idle`
  stops once nothing is left in flight; `--json` emits newline-delimited events.
  Results are committed to SQLite as each poll lands, so an abrupt kill loses
  nothing already collected.
- Request pacing: every API call is held to `GEMCATCH_RPM` requests/minute (default
  15, the free-tier allowance; `0` disables). Capping concurrency alone does not
  cap a rate, which a wide `sync` would otherwise discover the hard way.
- Retries: transient failures (429, 408, 5xx, network errors) get
  `GEMCATCH_MAX_RETRIES` further attempts (default 4) with exponential backoff and
  full jitter, honouring `Retry-After`. A 4xx is surfaced immediately — it will
  fail identically forever, and retrying it only burns the rate limit.
- `gemcatch cancel <id>` — asks the API to stop an in-flight task.
- `gemcatch rm <ids...>` — forgets tasks locally; `--remote` also deletes them server-side.
- `gemcatch prune` — drops finished tasks older than `--days` (default 30). Never
  touches in-flight work. `--dry-run` shows what would go.
- `gemcatch stats` — where the store lives and what's in it.
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

Free-tier interactions are retained server-side for 24 hours. Once `gemcatch` has
seen a task complete, the text is cached locally and survives that expiry — but
something has to poll inside that window for it to be seen at all, which is what
`gemcatch daemon` exists to do.

[Unreleased]: https://github.com/Booyaka101/gemcatch/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Booyaka101/gemcatch/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Booyaka101/gemcatch/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Booyaka101/gemcatch/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Booyaka101/gemcatch/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Booyaka101/gemcatch/releases/tag/v0.1.0
