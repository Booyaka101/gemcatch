# gemcatch

[![CI](https://github.com/Booyaka101/gemcatch/actions/workflows/ci.yml/badge.svg)](https://github.com/Booyaka101/gemcatch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gemcatch.svg)](https://www.npmjs.com/package/gemcatch)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Fire-and-forget research tasks for the Gemini API. Submit a long-running prompt, get a task ID back in under a second, close your laptop, collect the answer later.

On [July 7, 2026](https://blog.google/innovation-and-ai/technology/developers-tools/expanding-managed-agents-gemini-api/) Google added background execution to the Gemini Interactions API:

> Holding an HTTP connection open for long-running tasks is fragile. Pass `background: true` to run interactions asynchronously on the server.

That solves the server half. The client half is still on you: you get back an interaction ID and now you own it — polling it, remembering which prompt it belonged to, not losing it when your shell dies, noticing that the free tier throws it away after 24 hours. `gemcatch` is that half. It passes `background: true`, stores the interaction ID in local SQLite next to the prompt that created it, gives you a handful of commands to get results back, and runs a [daemon](#dont-lose-results-gemcatch-daemon) that collects them before the free tier drops them.

```console
$ gemcatch research "compare the 2026 EU AI Act timelines against the UK approach"
Task 8f3a1c04 submitted. Run: gemcatch get 8f3a1c04 when ready.

$ # ...close your laptop, come back later...

$ gemcatch get 8f3a1c04
The EU AI Act's high-risk obligations phase in from August 2026, whereas...
```

## Setup

Needs Node.js 22+ and a Gemini API key. **Getting a key needs no billing account and no card.** `gemini-3.1-flash-lite` runs free within the [free tier's](https://ai.google.dev/gemini-api/docs/pricing) daily quota; past that, paid rates apply.

1. Get a key at **<https://aistudio.google.com/apikey>**
2. Put it in your environment:

```powershell
# PowerShell
$env:GEMINI_API_KEY = "your-key-here"
```

```bash
# bash / zsh
export GEMINI_API_KEY=your-key-here
```

To make it permanent, add that line to your shell profile (`$PROFILE` on PowerShell, `~/.bashrc` or `~/.zshrc` on Unix). `GOOGLE_API_KEY` works too.

## Run

```bash
npx gemcatch research "your question"
```

Or install it once and use the short name:

```bash
npm install -g gemcatch
gemcatch research "your question"
```

From a clone: `npm install && node index.js research "your question"`.

## Three examples

```bash
# 1. Submit — returns immediately with a task ID
$ gemcatch research "summarize this week in AI"
Task 8f3a1c04 submitted. Run: gemcatch get 8f3a1c04 when ready.

# 2. Check on it — or `gemcatch list` to see everything
$ gemcatch status 8f3a1c04
Task 8f3a1c04: in_progress

# 3. Collect the answer (blocks and polls until done)
$ gemcatch watch 8f3a1c04
[10:52:31] 8f3a1c04: in_progress
[10:54:02] 8f3a1c04: completed
This week in AI: ...
```

## Commands

| Command | What it does |
| --- | --- |
| `gemcatch research "<prompt>"` | Submits with `background: true`, stores the interaction ID, exits immediately. |
| `gemcatch batch <file>` | Submits many prompts from a file at once, tagged as one collectable batch. |
| `gemcatch status <id>` | Polls the API and prints the current state. |
| `gemcatch get <id>` | Prints the full response if complete, otherwise the current status. |
| `gemcatch list` | All tasks, newest first: id, age, status, prompt. |
| `gemcatch watch <id>` | Polls until the task finishes, then prints the result. |
| `gemcatch sync` | Refreshes every in-flight task in one pass. |
| `gemcatch daemon` | Keeps polling in-flight tasks on a loop, so results are cached before they expire. |
| `gemcatch cancel <id>` | Asks the API to stop an in-flight task. |
| `gemcatch rm <ids...>` | Forgets tasks locally. `--remote` deletes them server-side too. |
| `gemcatch prune` | Drops finished tasks older than `--days` (default 30). |
| `gemcatch stats` | Where the store lives and what's in it. |

Useful flags:

| Flag | On | Does |
| --- | --- | --- |
| `--json` | most commands | Machine-readable output. |
| `-m, --model <id>` | `research`, `batch` | Override the model. |
| `-s, --system <text>` | `research`, `batch` | Set a system instruction. |
| `-f, --file <path>` | `research` | Read the prompt from a file. |
| `-t, --tag <tag>` | `research`, `batch`, `list` | Label tasks and filter them. |
| `-w, --watch` | `research`, `batch` | Submit and wait, in one command. |
| `--separator <str>` | `batch` | Split the file on this delimiter line for multi-line prompts. |
| `-i, --interval <s>` | `watch`, `daemon` | Poll rate. Default 10s for `watch`, 300s for `daemon`. |
| `--exit-when-idle` | `daemon` | Stop once nothing is left in flight. |
| `-n, --limit <n>` | `list` | Cap the rows. |
| `--dry-run` | `batch`, `prune` | Show what would go; submit/delete nothing. |
| `--raw` | `get` | Dump the raw interaction JSON. |

IDs are the first 8 characters of a UUID. Any unique prefix works, so `gemcatch get 8f3a` is fine.

Statuses come straight from the API: `in_progress`, `requires_action`, `completed`, `failed`, `cancelled`, `incomplete`, `budget_exceeded`. Plus `pending`, which is local: the row exists but the submit call hasn't returned yet.

## Recipes

```bash
# Fire off a whole file of prompts in one command, then collect later.
# Every task shares one auto-generated tag (batch-xxxxxx), printed on submit.
$ gemcatch batch questions.txt        # one prompt per line; # and blanks skipped
$ gemcatch daemon --exit-when-idle    # keep polling until they're all in
$ gemcatch list --tag batch-1a2b3c --status completed

# Multi-line prompts: split the file on a delimiter line instead of per-line
$ gemcatch batch briefs.md --separator ---
$ gemcatch batch - < questions.txt    # or pipe the list in on stdin

# The same thing by hand, if you prefer a loop
$ for q in "topic A" "topic B" "topic C"; do gemcatch research "$q" -t batch1; done
$ gemcatch sync                       # one pass now...
$ gemcatch daemon --exit-when-idle    # ...or keep polling until they're all in
$ gemcatch list --tag batch1 --status completed

# Long prompt from a file, result to a file.
# Progress goes to stderr, so the redirect captures only the answer.
$ gemcatch research -f brief.md -w > answer.md

# Pipe a prompt in
$ cat notes.txt | gemcatch research - -s "extract every open question"

# Script against it
$ id=$(gemcatch research "..." --json | jq -r .id)
$ gemcatch watch "$id" --json | jq -r .result
```

## How it works

Tasks live in SQLite at `~/.gemcatch/tasks.db` (override with `GEMCATCH_HOME`):

```sql
CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT, interaction_id TEXT,
                    status TEXT DEFAULT 'pending', result TEXT, created_at INTEGER);
-- plus model, system_instruction, tag, error, usage, updated_at
```

`research` calls `interactions.create({model, input, background: true})` via [`@google/genai`](https://www.npmjs.com/package/@google/genai) and keeps the returned `id`. The polling commands call `interactions.get(id)` and write the status back. Once a task completes, the text is cached in the `result` column — `gemcatch get` then answers from disk without touching the network.

An older `tasks.db` upgrades in place; migrations are additive and never drop a row.

**Free-tier results expire after 24 hours.** The [docs](https://ai.google.dev/gemini-api/docs/interactions-overview) note the system retains interactions for 1 day on the free tier (55 days paid). Once `gemcatch` has seen a task complete, the text is cached locally and survives that expiry — but a task nobody polls inside that window is gone server-side. That is what `gemcatch daemon` is for.

## Don't lose results: `gemcatch daemon`

Caching a result permanently is easy; *noticing* it is the hard part. If nothing polls a finished task within 24 hours, the answer is dropped server-side and no amount of local bookkeeping brings it back. `gemcatch daemon` is the something that looks:

```console
$ gemcatch daemon
gemcatch daemon: polling every 300s. Store: ~/.gemcatch/tasks.db. Ctrl-C to stop.
[10:54:02] 8f3a1c04: completed
[11:31:20] c7b91e55: completed
```

It refreshes everything in flight on an interval, writes each result to SQLite the moment it lands, and stays quiet otherwise — only transitions and errors get a line. It's an ordinary foreground process: no forking, no pidfile. Leave it in a terminal, or hand it to whatever supervises long-running jobs on your machine (a systemd user unit, a launchd agent, Task Scheduler at log-on, `nohup`, `pm2`).

**Nothing is lost if it dies.** Every poll is committed to SQLite synchronously, so killing the daemon — Ctrl-C, `kill -9`, a reboot — stops the polling and nothing else. Results it already collected are on disk, and restarting picks up where it left off.

`--exit-when-idle` stops once nothing is in flight, which makes it the "collect this batch, then quit" one-liner:

```bash
$ for q in "topic A" "topic B" "topic C"; do gemcatch research "$q" -t batch1; done
$ gemcatch daemon --exit-when-idle -i 30
$ gemcatch list --tag batch1 --status completed
```

## Rate limits and retries

The free tier allows roughly 15 requests a minute, which a wide `gemcatch sync` or a busy daemon would otherwise blow straight through. Every outbound call is paced to `GEMCATCH_RPM` (default 15) — set it higher on a paid key, or `0` to disable pacing entirely.

Transient failures are retried with exponential backoff and full jitter, honouring `Retry-After` when the server sends it. A rate limit, a timeout or a 5xx gets `GEMCATCH_MAX_RETRIES` more attempts (default 4); a 4xx does not, because a bad key or a bad model id fails identically forever and retrying it only burns your quota.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Your API key. `GOOGLE_API_KEY` also works. |
| `GEMCATCH_HOME` | Where `tasks.db` lives. Default `~/.gemcatch`. |
| `GEMCATCH_MODEL` | Default model. Default `gemini-3.1-flash-lite`. |
| `GEMCATCH_POLL_MS` | `watch` poll interval in ms. Default `10000`. |
| `GEMCATCH_DAEMON_S` | `daemon` interval in seconds. Default `300`. |
| `GEMCATCH_RPM` | Requests/minute ceiling. Default `15` (the free tier). `0` disables pacing. |
| `GEMCATCH_MAX_RETRIES` | Extra attempts on a transient failure. Default `4`. `0` disables retries. |
| `GEMCATCH_BASE_URL` | Override the API endpoint (proxy/gateway/testing). |
| `GEMCATCH_FORCE_REST` | `1` bypasses the SDK and uses raw `fetch`. |
| `NO_COLOR` | Disable colour output. |

## Development

```bash
git clone https://github.com/Booyaka101/gemcatch
cd gemcatch
npm install
npm test
```

**The tests need no API key and no network.** They run the real CLI as a subprocess against a mock Interactions API on localhost, covering every command, the failure paths, and schema migration. See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout and for the API gotchas worth knowing before touching `gemini.js`.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Security reports go through [private disclosure](SECURITY.md), not public issues.

## License

[MIT](LICENSE)
