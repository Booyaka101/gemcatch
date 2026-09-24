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

Needs Node.js 22+ and a Gemini API key. **Getting a key needs no billing account and no card.** `gemini-3.5-flash-lite` (the default model, GA since July 2026) runs free within the [free tier's](https://ai.google.dev/gemini-api/docs/pricing) daily quota; past that, paid rates apply.

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
| `gemcatch get <id>` | Prints the full response if complete, otherwise the current status. On a [plan](#see-the-plan-before-you-pay-for-the-run), the plan plus the approve/refine commands. |
| `gemcatch refine <id> "<instruction>"` | Sends an instruction back to a plan and returns a revised plan. |
| `gemcatch approve <id>` | Approves a plan and submits the research run it describes. |
| `gemcatch list` | All tasks, newest first: id, age, status, prompt. Plan chains are indented under their root. |
| `gemcatch export` | Concatenates finished results, each under its prompt, to stdout or a file (Markdown or JSON). |
| `gemcatch digest` | Feeds a tag's completed results through one Gemini call into a single summary. |
| `gemcatch watch <id>` | Polls until the task finishes, then prints the result. |
| `gemcatch sync` | Refreshes every in-flight task in one pass. |
| `gemcatch daemon` | Keeps polling in-flight tasks on a loop, so results are cached before they expire. |
| `gemcatch cancel <id>` | Asks the API to stop an in-flight task. |
| `gemcatch rm <ids...>` | Forgets tasks locally. `--remote` deletes them server-side too. |
| `gemcatch prune` | Drops finished tasks older than `--days` (default 30). |
| `gemcatch stats` | Where the store lives, what's in it, and what the agent runs have plausibly cost. |

Useful flags:

| Flag | On | Does |
| --- | --- | --- |
| `--json` | most commands | Machine-readable output. |
| `-m, --model <id>` | `research`, `batch` | Override the model. |
| `-a, --agent <id>` | `research`, `batch` | Submit to a [research agent](#research-agents) instead of a model. Mutually exclusive with `--model`. |
| `--plan` | `research`, `batch` | Ask the agent for a [research plan](#see-the-plan-before-you-pay-for-the-run) first, to refine and approve. Needs `--agent`. |
| `--attach <path\|url>` | `research`, `batch` | Give the agent a PDF, CSV or image ([your own data](#research-over-your-own-data)). Repeatable. Needs `--agent`. |
| `--mcp <url>` | `research`, `batch` | Let the agent call a remote MCP server. Repeatable; `--mcp-header`, `--mcp-allow` and `--mcp-name` apply to the one before them. Needs `--agent`. |
| `--file-search <store>` | `research`, `batch` | Let the agent search a File Search store. Repeatable. Needs `--agent`. |
| `--no-web` | `research`, `batch` | Drop Google Search and URL Context, so the agent reads only what you gave it. Needs `--agent`. |
| `--visualize` | `research`, `batch` | Let the agent draw charts; they're saved as image files. Needs `--agent`. |
| `--yes` | `research`, `batch`, `refine`, `approve` | Confirm the agent cost without asking. Required for `--agent` when stdin is not a TTY. |
| `-s, --system <text>` | `research`, `batch` | Set a system instruction. |
| `-f, --file <path>` | `research` | Read the prompt from a file. |
| `-t, --tag <tag>` | `research`, `batch`, `list` | Label tasks and filter them. |
| `-w, --watch` | `research`, `batch` | Submit and wait, in one command. |
| `--separator <str>` | `batch` | Split the file on this delimiter line for multi-line prompts. |
| `-i, --interval <s>` | `watch`, `daemon` | Poll rate in seconds; must be > 0. Default 10s for `watch`, 300s for `daemon`. |
| `--exit-when-idle` | `daemon` | Stop once nothing is left in flight. |
| `--status <s>` | `list`, `export` | Only tasks in this status. |
| `-n, --limit <n>` | `list` | Cap the rows (non-negative; `0` shows none). |
| `--format <md\|json>` | `export` | Output format. Default `md`. |
| `-o, --out <file>` | `export` | Write to a file instead of stdout. |
| `--include-plans` | `export` | Also emit a chain's plan turns, not just its report. |
| `--dry-run` | `research`, `batch`, `refine`, `approve`, `prune` | Show what would go — including the projected agent spend; submit/delete nothing. |
| `--raw` | `get` | Dump the raw interaction JSON. |

IDs are the first 8 characters of a UUID. Any unique prefix works, so `gemcatch get 8f3a` is fine.

Statuses come straight from the API: `in_progress`, `requires_action`, `completed`, `failed`, `cancelled`, `incomplete`, `budget_exceeded`. Plus `pending`, which is local: the row exists but the submit call hasn't returned yet.

## Recipes

```bash
# Fire off a whole file of prompts in one command, then collect later.
# Every task shares one auto-generated tag (batch-xxxxxx), printed on submit.
$ gemcatch batch questions.txt        # one prompt per line; "# " and blanks skipped
$ gemcatch daemon --exit-when-idle    # keep polling until they're all in
$ gemcatch list --tag batch-1a2b3c --status completed

# Collect a whole batch into one document (the "gather" for batch's "scatter").
$ gemcatch export --tag batch-1a2b3c -o results.md   # Markdown, one section per prompt
$ gemcatch export --tag batch-1a2b3c --format json | jq -r '.[].result'
$ gemcatch digest --tag batch-1a2b3c                 # or synthesize them into one summary

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

## Research agents

The [Gemini Deep Research agents](https://ai.google.dev/gemini-api/docs/deep-research) are reachable only through the Interactions API, and the docs are explicit: *"You must use background execution (set `background=true`) to run the agent asynchronously and poll for results or stream updates."* That is precisely the half of the job `gemcatch` already does — it always sets `background: true`, owns the polling, and its daemon collects results before the free tier drops interactions after **1 day** (paid tier: 55 days). A Deep Research run takes minutes and you were never going to sit there holding the connection; submit it, and let the daemon catch it.

```console
$ gemcatch research "map the EU AI Act high-risk obligations against the UK approach" --agent deep-research
Agent deep-research-preview-04-2026 — estimated $1.00–$3.00 for this task (preview rates, subject to change).
Submit? [y/N] y
Task 8f3a1c04 submitted. Run: gemcatch get 8f3a1c04 when ready.
```

`--agent` takes an alias or a raw agent id:

| You type | Sent to the API |
| --- | --- |
| `deep-research` | `deep-research-preview-04-2026` |
| `deep-research-max` | `deep-research-max-preview-04-2026` |
| anything else | passed through unchanged (future agent ids work without a gemcatch release; a bad id fails fast with the API's own 4xx) |

An agent is sent **instead of** a model — the agent picks its own models — so `--model` and `--agent` together is an error, and nothing is submitted.

**These agents cost real money, per task.** The docs put Deep Research at **$1.00–$3.00 per task** and Deep Research Max at **$3.00–$7.00 per task** — with their own hedge attached: *"These figures are estimates based on preview rates and are subject to change."* Because `gemcatch batch` fires a whole file at once, a 20-line file against `deep-research-max` is a **$60–$140 command**, so every agent submission shows its band and asks first. In a script (stdin not a TTY) you must pass `--yes`; `--dry-run` prints the full projected spend and submits nothing:

```console
$ gemcatch batch questions.txt --agent deep-research-max --dry-run
20 prompts × deep-research-max-preview-04-2026 — estimated $60.00–$140.00 total. Nothing submitted (--dry-run).
```

The report lands like any other result — final answer only, none of the agent's interim plan — and its **citations** come with it. The docs tell you to review them to verify the sources, so `gemcatch get` prints them under the report as a `Sources:` list, `--json` carries them as an array, and they live in the store alongside the result.

An agent run can also come back `incomplete` — that is what a `max_total_tokens` budget cap produces when the run "safely pauses" — which `gemcatch` treats as terminal, exactly like the API does: the daemon retires it and moves on.

### See the plan before you pay for the run

A cost band tells you what a run will cost. It tells you nothing about whether the agent understood the question. Add `--plan` and it doesn't start researching: with `agent_config.collaborative_planning: true`, *"the agent returns a research plan instead of a full report"*. You read it, push back on it, and approve it when it's right.

```console
$ gemcatch research "map the EU AI Act high-risk obligations against the UK approach" --agent deep-research --plan -t euuk
Agent deep-research-preview-04-2026 (planning turn) — estimated $1.00–$3.00 for this task (preview rates, subject to change; the docs price per task and do not price a planning turn separately).
Submit? [y/N] y
Plan task d014e21b submitted. Run: gemcatch get d014e21b when ready.

$ gemcatch get d014e21b
Research plan

1. Scope the EU AI Act high-risk regime: Annex III use cases, Article 6 classification,
   and the Chapter III obligations (risk management, data governance, logging, human
   oversight, conformity assessment) with their August 2026 / August 2027 dates.
2. Scope the UK approach: the five cross-sector principles, the regulator-led model
   (ICO, FCA, MHRA, Ofcom), and what is guidance rather than statute.
3. Build an obligation-by-obligation comparison table: EU requirement, nearest UK
   equivalent, whether it is binding, and who enforces it.
4. Flag the gaps in both directions and the compliance implications for a firm
   operating in both.
Approve with: gemcatch approve d014e21b   ·   Refine with: gemcatch refine d014e21b "..."

$ gemcatch refine d014e21b "cut the history, and add enforcement penalties on both sides"
Plan task 2140e699 submitted (refines d014e21b). Run: gemcatch get 2140e699 when ready.

$ gemcatch approve 2140e699
Agent deep-research-preview-04-2026 — estimated $1.00–$3.00 for this task (preview rates, subject to change).
Submit? [y/N] y
Task 96e8209b submitted (approves plan 2140e699).
```

Every turn is an ordinary background task: stored, polled, and collected by the daemon before the 1-day expiry, same as everything else. `refine` chains as many times as you like; each revision inherits the agent and tag of the plan it came from.

**A planning turn is a task, and it is billed as one.** The docs publish one band per task and price no planning turn separately, so `gemcatch` quotes the same band for it and says exactly that on the line. What `--plan` buys you is a look at the plan before you commit to the research run, not a discount. Budget for the plan, each refinement, and the run.

Since a chain bills per turn, `gemcatch stats` keeps a running total across all of them:

```console
$ gemcatch stats
Store: ~/.gemcatch/tasks.db
Tasks: 3
  completed         3
Agent runs:
  deep-research-preview-04-2026      3
Plan chains: 2 plan, 1 report
Estimated spend: $3.00–$9.00 across 3 billed task(s) (preview rates, subject to change).
```

That's the chain above: one plan, one refinement, one run, three tasks at the same band. It's the published bands applied to what you actually submitted, not a reading of your bill, and it errs toward telling you rather than flattering you:

- Only runs that **reached the server** are priced. A submit that failed before it left the machine (bad key, rejected agent id) is still counted under "Agent runs" as an attempt, but it costs nothing and isn't billed.
- An agent with **no published band** totals to `unknown`, never to `$0.00`. Quoting zero for a run that costs real money is the one thing a spend guard must not do.

`list` shows the chain as one thing, and `export` follows it to the report:

```console
$ gemcatch list
ID        AGE   STATUS           KIND    AGENT              PROMPT
d014e21b  22s   completed        plan    deep-research      map the EU AI Act high-risk obligations against the UK ap...
2140e699  12s   completed        plan    deep-research      └─ cut the history, and add enforcement penalties on both sides
96e8209b  7s    completed        report  deep-research        └─ map the EU AI Act high-risk obligations against the UK ap...

$ gemcatch export --tag euuk -o report.md
Wrote 1 result(s) to report.md.
```

The plans are working notes on the way to the report, so `export` leaves them out; pass `--include-plans` if you want the whole chain in the document. The report is filed under the question that started the chain rather than the one-line approval actually sent to the API, so an exported document reads as research.

A few things that will bite otherwise:

- `--plan` needs `--agent`. Collaborative planning is an agent feature, so `--plan --model ...` (or `--plan` on its own) is an error, not a no-op.
- `approve` only works on a plan that has completed. Anything else fails before a request goes out.
- On the free tier the plan's interaction is dropped after a day. Once that happens the chain cannot be continued. `approve` says so and names the window instead of sending a `previous_interaction_id` the server will reject. Run the daemon, or approve the same day.
- Approving twice submits twice. There is no dedupe, and both runs show up under the plan in `list`.
- `--plan` and `--watch` work together: `gemcatch research "..." --agent deep-research --plan -w` waits for the plan and then prints it.

The agent recipe, end to end:

```bash
$ gemcatch batch questions.txt --agent deep-research --plan --yes   # a plan per prompt, N × band quoted
$ gemcatch daemon --exit-when-idle                                  # catch the plans
$ gemcatch list --tag batch-1a2b3c                                  # read them, approve the good ones
$ gemcatch approve 8f3a1c04 --yes
$ gemcatch daemon --exit-when-idle                                  # catch the reports before the 1-day expiry
$ gemcatch export --tag batch-1a2b3c -o reports.md                  # every report, with its sources
```

Drop `--plan` and the first two lines become the 0.4.0 one-shot flow, which still works exactly as it did.

## Research over your own data

Out of the box a Deep Research agent reads the public web. These flags hand it your files, your MCP servers and your File Search stores as well, and `--visualize` lets it draw charts. They are agent features, so every one of them needs `--agent`. Without it gemcatch stops with one line naming the flag and sends nothing.

### Files: `--attach`

```console
$ gemcatch research "Which region is growing fastest, and does the board pack agree?" --agent deep-research \
    --attach sales-2026.csv --attach q3-board-pack.pdf --attach whiteboard.png \
    --attach customer-contracts-2026.pdf --yes
Attachments: sales-2026.csv (inline, 1 KB); q3-board-pack.pdf (inline, 1 KB); whiteboard.png (inline, 1 KB); customer-contracts-2026.pdf (upload, 40.0 MB)
Agent deep-research-preview-04-2026 — estimated $1.00–$3.00 for this task (preview rates, subject to change).
Uploading customer-contracts-2026.pdf (40.0 MB) to the Files API...
Task 7cf00c5b submitted. Run: gemcatch get 7cf00c5b when ready.
```

PDF and CSV go in as documents; PNG, JPEG, WebP, HEIC, HEIF, GIF and BMP as images. The type comes from the extension, and anything else is refused before you're asked to pay, with a nudge to export a Word file as PDF or a spreadsheet as CSV. `--attach` also takes an https URL, which is passed to the agent by reference. A URL with no supported extension (arxiv's `https://arxiv.org/pdf/1706.03762`, say) gets one HEAD request to read its Content-Type, or a one-byte GET if the server refuses HEAD. The query string of a signed URL is sent as given and shown as `***` everywhere else, the store included.

Local files are sent inline, in the order given, as long as the request stays under the API's inline limit: 100 MB of base64, or 50 MB once a PDF is in it. The first file that doesn't fit, and every file after it, goes up through the Files API instead and is referenced by URI. Google keeps uploads for 48 hours. On a `--plan` run gemcatch prints when they expire, and a `refine` or `approve` after that gets a warning. A file given twice is sent once.

In a `batch` with more than one prompt, every local file is uploaded, once, and each prompt points at the upload. Inline bytes would otherwise go over the wire again with every prompt.

Files go with the first turn only. A `refine` or `approve` continues the same conversation, and the files are already in it.

### MCP servers: `--mcp`

```console
$ gemcatch research "Which accounts are at risk of churn this quarter?" --agent deep-research --plan --yes \
    --mcp https://mcp.example-crm.com/mcp \
    --mcp-header 'Authorization: Bearer ${CRM_TOKEN}' \
    --mcp-allow search_accounts,get_account
Tools: google_search; url_context; code_execution; MCP mcp.example-crm.com https://mcp.example-crm.com/mcp (Authorization: ***) [search_accounts, get_account]
Agent deep-research-preview-04-2026 (planning turn) — estimated $1.00–$3.00 for this task (preview rates, subject to change; the docs price per task and do not price a planning turn separately).
Plan task 5451f8b9 submitted. Run: gemcatch get 5451f8b9 when ready.
```

`--mcp` is repeatable, and `--mcp-header`, `--mcp-allow` and `--mcp-name` apply to the `--mcp` just before them. The server is named after its host unless you pass `--mcp-name`, and two servers on one host become `host` and `host-2`. Giving two servers the same `--mcp-name`, or one server the same header twice, is refused. Google's servers make the call, not your machine, so the URL has to be reachable from the internet; a localhost or private address gets a warning, and so does a plain `http://` URL that carries credentials.

Header values, and any user, password, query string or fragment in an MCP URL, never appear in anything gemcatch prints: the confirmation, `--dry-run`, `list --json`, `get --raw` and API errors all show `***`.

Note the single quotes in the example. gemcatch reads `${CRM_TOKEN}` from the environment itself, each time a turn is sent, so `tasks.db` only ever holds the reference. A `refine` or `approve` needs the variable set too, and stops in one line naming it if it isn't. A value written out in full, or expanded by your shell, is stored as given, because a later turn has to send it again. On Linux and macOS gemcatch keeps `~/.gemcatch` readable by you alone.

### File Search stores: `--file-search`

```console
$ gemcatch research "What does our playbook say about discounting?" --agent deep-research \
    --file-search sales-playbooks --no-web --dry-run
Tools: code_execution; File Search fileSearchStores/sales-playbooks
Agent deep-research-preview-04-2026 — estimated $1.00–$3.00 for this task. Nothing submitted (--dry-run).
```

Repeat it for more stores; they all go in one `file_search` tool. A bare name gets `fileSearchStores/` put in front of it. gemcatch doesn't create or fill stores, [the File Search docs](https://ai.google.dev/gemini-api/docs/file-search) cover that.

### Charts: `--visualize`

```console
$ gemcatch research "Which region is growing fastest, and does the board pack agree?" --agent deep-research \
    --attach sales-2026.csv --visualize --yes -w
...
(report text)

Images:
  /home/you/.gemcatch/images/7cf00c5b-1.png
```

This sets `agent_config.visualization` to `auto`, next to `collaborative_planning` when you also pass `--plan`. The charts in the final report are written to the data directory's `images/` folder as `<task-id>-<n>.<ext>`, and listed under the report by `get`, `watch` and `digest`, and as `images` in `--json`. `export -o report.md` copies them next to the export and links them in the Markdown. `rm` and `prune` delete them with the task.

### What the agent can reach: `--no-web`

With no source flags gemcatch sends no `tools` field and the agent gets its defaults: Google Search, URL Context and Code Execution. The API reads an explicit list as the whole set, so once you add `--mcp` or `--file-search`, gemcatch lists those three back in alongside your sources. `--attach` alone sends no list at all, since a file isn't a tool.

`--no-web` drops Google Search and URL Context, so the agent works only from what you gave it. Code Execution stays: it can't reach the web, and it's what the agent uses to crunch a CSV and draw a chart. On its own `--no-web` is refused, because it would leave the agent nothing to read.

`refine` and `approve` send the plan's tools and visualization setting again, so every turn of a chain reaches the same sources. Once a task in the listing used any of this, `list` grows a SOURCES column (`mcp`, `store`, `no-web`, `2 files`, `charts`).

## How it works

Tasks live in SQLite at `~/.gemcatch/tasks.db` (override with `GEMCATCH_HOME`):

```sql
CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT, interaction_id TEXT,
                    status TEXT DEFAULT 'pending', result TEXT, created_at INTEGER);
-- plus model, system_instruction, tag, error, usage, updated_at, agent, citations,
--      collaborative_planning, previous_interaction_id, kind, parent_id,
--      tools_json, attachments_json, visualization, images_json
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

If a task's interaction has vanished server-side — the free tier dropped it after 24h, or it was deleted — polling it returns a 404. Rather than chase a task that can never resolve, `gemcatch` retires it locally to `incomplete`, so it leaves the in-flight set and `--exit-when-idle` still converges. `watch` and `batch -w` also give up after a bounded run of consecutive poll failures (`GEMCATCH_WATCH_MAX_FAILS`, default 10) instead of looping forever.

## Rate limits and retries

The free tier allows roughly 15 requests a minute, which a wide `gemcatch sync` or a busy daemon would otherwise blow straight through. Every outbound call is paced to `GEMCATCH_RPM` (default 15) — set it higher on a paid key, or `0` to disable pacing entirely.

Pacing is **per process**: each `gemcatch` invocation keeps its own counter, so two running at once (a `daemon` in one terminal and a one-off `sync` in another) can together exceed the ceiling. If you need the limit to hold, run a single daemon and let it do the polling.

Transient failures are retried with exponential backoff and full jitter, honouring `Retry-After` when the server sends it. A rate limit, a timeout or a 5xx gets `GEMCATCH_MAX_RETRIES` more attempts (default 4); a 4xx does not, because a bad key or a bad model id fails identically forever and retrying it only burns your quota.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Your API key. `GOOGLE_API_KEY` also works. |
| `GEMCATCH_HOME` | Where `tasks.db` lives. Default `~/.gemcatch`. |
| `GEMCATCH_MODEL` | Default model. Default `gemini-3.5-flash-lite`. |
| `GEMCATCH_POLL_MS` | `watch` poll interval in ms. Default `10000`. |
| `GEMCATCH_UPLOAD_POLL_MS` | How often an upload still being processed by the Files API is checked, in ms. Default `2000`. |
| `GEMCATCH_DAEMON_S` | `daemon` interval in seconds. Default `300`. |
| `GEMCATCH_RPM` | Requests/minute ceiling. Default `15` (the free tier). `0` disables pacing. |
| `GEMCATCH_MAX_RETRIES` | Extra attempts on a transient failure. Default `4`. `0` disables retries. |
| `GEMCATCH_WATCH_MAX_FAILS` | Consecutive poll failures before `watch`/`batch -w` give up. Default `10`. |
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
