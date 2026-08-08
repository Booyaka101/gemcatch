#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { Command, Option } = require('commander');
const store = require('./db');
const gemini = require('./gemini');
const { TERMINAL, ACTIVE, PENDING, isDone, isSuccess } = require('./status');

const DEFAULT_POLL_MS = Number(process.env.GEMCATCH_POLL_MS) || 10000;
// Free-tier results are dropped after 24h, so the daemon only has to be
// comfortably faster than that. Five minutes is far inside the margin and
// costs a handful of requests an hour.
const DEFAULT_DAEMON_S = Number(process.env.GEMCATCH_DAEMON_S) || 300;
// A watch loop must not spin forever on a task the server can no longer resolve
// -- a wedged in_progress, or transient poll errors that never clear. `watch`
// and `batch -w` give up after this many *consecutive* poll failures (a clean
// poll resets the run), surfacing a clear message and a non-zero exit instead
// of hanging. The daemon, meant to run for days, is bounded differently: a 404
// retires the task locally (see refresh) so it simply leaves the active set.
const WATCH_MAX_FAILS = Number(process.env.GEMCATCH_WATCH_MAX_FAILS) || 10;
const ALL_STATUSES = [PENDING].concat(ACTIVE, TERMINAL);

// --- output ---------------------------------------------------------------

// Colour is decided per stream. Progress and status chatter go to stderr
// (watch/daemon/research -w); results and tables go to stdout. Each stream keys
// its ANSI on its *own* TTY-ness, so redirecting one (`gemcatch watch x > out.txt`)
// neither strips colour from the other nor leaks raw escape codes into the
// redirected file. NO_COLOR disables both.
const NO_COLOR = !!process.env.NO_COLOR;
const useColor = process.stdout.isTTY && !NO_COLOR; // stdout-bound colour
const useColorErr = process.stderr.isTTY && !NO_COLOR; // stderr-bound colour

const wrap = (on) => (code, s) => (on ? `[${code}m${s}[0m` : s);
const paint = wrap(useColor); // paints for stdout
const epaint = wrap(useColorErr); // paints for stderr
const dim = (s) => paint('2', s);
const edim = (s) => epaint('2', s);

// Status colour keyed to a given painter, so one rule set serves both streams.
function tint(pnt, s) {
  if (isSuccess(s)) return pnt('32', s); // green
  if (s === 'in_progress' || s === PENDING) return pnt('36', s); // cyan
  if (s === 'requires_action') return pnt('33', s); // yellow
  return pnt('31', s); // red: failed/cancelled/incomplete/budget_exceeded
}
const colorStatus = (s) => tint(paint, s); // for stdout
const ecolorStatus = (s) => tint(epaint, s); // for stderr

const hhmmss = () => new Date().toISOString().slice(11, 19);

function age(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function emit(json, value, human) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else human();
}

// One-line preview of a prompt for the list/batch columns.
function snippet(prompt, n = 60) {
  const s = (prompt || '').replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

function die(err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

function needTask(id) {
  let task;
  try {
    task = store.getTask(id);
  } catch (err) {
    die(err); // ambiguous prefix
  }
  if (!task) {
    console.error(`Error: no task matching '${id}'. Try: gemcatch list`);
    process.exit(1);
  }
  return task;
}

// Citations ride along with an agent's report -- the docs tell users to review
// them to verify the sources, so they are printed under the result rather than
// left in the database. A run without citations prints exactly as before.
function withSources(text, citations) {
  const body = text || '(empty response)';
  if (!Array.isArray(citations) || !citations.length) return body;
  const lines = citations.map((c, i) => {
    const title = (c && (c.title || c.text)) || '';
    const url = (c && (c.url || c.uri)) || '';
    return `  [${i + 1}] ${[title, url].filter(Boolean).join(' — ') || JSON.stringify(c)}`;
  });
  return `${body}\n\nSources:\n${lines.join('\n')}`;
}

// The citations column holds JSON (or NULL). Parsed defensively: a corrupt row
// degrades to "no sources", never a crash in the middle of printing a result.
function parseCitations(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length ? v : null;
  } catch (_) {
    return null;
  }
}

// --- spend guard ----------------------------------------------------------

// Deep Research agents are billed PER TASK, not per token -- the docs put
// Deep Research at $1.00-$3.00 and Deep Research Max at $3.00-$7.00 -- and
// gemcatch's whole ergonomic is firing a file of prompts at once, which turns
// one careless `batch --agent` into a three-figure command. So no agent
// submission happens without the cost being shown and confirmed: interactively
// on a TTY, via --yes otherwise, and --dry-run previews without submitting.
// The bands are quoted with the docs' own hedge ("estimates based on preview
// rates and subject to change"), never as authoritative.

function bandText(agentId, count) {
  const band = gemini.AGENT_PRICE_BANDS[agentId];
  if (!band) return 'no published price band for this agent';
  const money = (n) => `$${(n * count).toFixed(2)}`;
  return count > 1
    ? `estimated ${money(band[0])}–${money(band[1])} total`
    : `estimated ${money(band[0])}–${money(band[1])} for this task`;
}

function spendLine(agentId, count) {
  const head = count > 1 ? `${count} prompts × ${agentId}` : `Agent ${agentId}`;
  return `${head} — ${bandText(agentId, count)}`;
}

function askYesNo(question) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test((answer || '').trim()));
    });
  });
}

// Returns only when the submission is confirmed; otherwise it exits (declined)
// or throws (no way to ask). Runs BEFORE any row is written, so a declined or
// refused submission leaves the tasks table untouched.
async function confirmSpend(agentId, count, opts) {
  console.error(`${spendLine(agentId, count)} (preview rates, subject to change).`);
  if (opts.yes) return;
  // GEMCATCH_ASSUME_TTY lets the offline suite drive the interactive branch
  // through a pipe; real non-TTY callers (cron, CI, scripts) must say --yes.
  const interactive = process.stdin.isTTY || process.env.GEMCATCH_ASSUME_TTY === '1';
  if (!interactive) {
    throw new Error(
      'stdin is not a TTY, so this agent submission cannot be confirmed interactively.\n' +
        '  Pass --yes to confirm the cost above, or --dry-run to preview without submitting.'
    );
  }
  if (!(await askYesNo('Submit? [y/N] '))) {
    console.error('Nothing submitted.');
    process.exit(1);
  }
}

// Shared by research and batch: resolve the agent alias and reject the
// ambiguous combination before anything is stored or sent. `--model` counts
// only when the user actually typed it -- commander fills in the default
// otherwise, and the default must not poison every agent run.
function resolveAgentOpts(opts, cmd) {
  if (!opts.agent) return null;
  if (cmd.getOptionValueSource('model') === 'cli') {
    throw new Error(
      '--model and --agent are mutually exclusive: an agent run is submitted with `agent` ' +
        'instead of `model`, and the agent picks its own models. Drop one of the two.'
    );
  }
  return gemini.resolveAgent(opts.agent);
}

// --- input ----------------------------------------------------------------

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

async function resolvePrompt(arg, opts) {
  if (opts.file) {
    const text = fs.readFileSync(opts.file, 'utf8').trim();
    if (!text) throw new Error(`${opts.file} is empty`);
    return text;
  }
  if (arg === '-') {
    const text = await readStdin();
    if (!text) throw new Error('no prompt on stdin');
    return text;
  }
  if (arg && arg.trim()) return arg.trim();
  throw new Error('provide a prompt, --file <path>, or "-" to read stdin');
}

// --- core -----------------------------------------------------------------

// Poll one task and persist whatever came back.
async function refresh(task) {
  if (!task.interaction_id) return { status: task.status, text: null, usage: null };
  let r;
  try {
    r = await gemini.poll(task.interaction_id);
  } catch (err) {
    // A 404 is genuine and permanent: the interaction is gone -- dropped after
    // the free tier's 24h retention, or deleted -- and it will 404 identically
    // forever (a 4xx never retries). Retire the task locally so it leaves the
    // active set, instead of the daemon or a watch loop polling a ghost until
    // the end of time. Any other error (5xx, network) is transient and is
    // re-thrown for the caller to retry on its next pass.
    if (err && err.httpStatus === 404) {
      store.setStatus(task.id, 'incomplete', { error: 'interaction not found (expired or deleted)' });
      return { status: 'incomplete', text: null, usage: null, raw: null };
    }
    throw err;
  }
  const extra = {};
  if (isDone(r.status)) {
    if (isSuccess(r.status)) {
      extra.result = r.text;
      // Agent runs return citations with the report; the docs tell users to
      // review them to verify the sources, so they are persisted, not dropped.
      if (r.citations && r.citations.length) extra.citations = JSON.stringify(r.citations);
    } else if (r.text) extra.error = r.text;
  }
  if (r.usage) extra.usage = JSON.stringify(r.usage);
  store.setStatus(task.id, r.status, extra);
  return r;
}

// Bounds how many polls are open at once. The *rate* limit is enforced in
// gemini.js (GEMCATCH_RPM), which is the part that keeps a wide fan-out inside the
// free tier's requests-per-minute allowance.
async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

const program = new Command();
program
  .name('gemcatch')
  .description("Fire-and-forget research tasks on Gemini's Interactions API (background execution).")
  .version(require('./package.json').version);

// --- research -------------------------------------------------------------

program
  .command('research')
  .argument('[prompt]', 'what you want researched; "-" reads stdin')
  .option('-f, --file <path>', 'read the prompt from a file')
  .option('-m, --model <id>', 'model to use', gemini.DEFAULT_MODEL)
  .option('-a, --agent <id>', 'submit to a research agent instead of a model (e.g. deep-research)')
  .option('-s, --system <text>', 'system instruction')
  .option('-t, --tag <tag>', 'label for filtering with `gemcatch list --tag`')
  .option('-w, --watch', 'wait for the result instead of exiting')
  .option('--yes', 'confirm the agent cost without asking (required when stdin is not a TTY)')
  .option('--dry-run', 'show what would be submitted (and what it would cost); submit nothing')
  .option('--json', 'machine-readable output')
  .description('submit a background task and exit immediately')
  .action(async (promptArg, opts, cmd) => {
    let id;
    try {
      const agent = resolveAgentOpts(opts, cmd);
      const prompt = await resolvePrompt(promptArg, opts);
      if (opts.dryRun) {
        emit(opts.json, { dry_run: true, agent: agent || null, model: agent ? null : opts.model, prompt }, () => {
          if (agent) console.log(`${spendLine(agent, 1)}. Nothing submitted (--dry-run).`);
          else console.log(`Would submit to ${opts.model}: ${snippet(prompt)}. Nothing submitted (--dry-run).`);
        });
        return;
      }
      if (agent) await confirmSpend(agent, 1, opts);
      id = store.createTask({
        prompt,
        model: agent ? null : opts.model,
        agent,
        systemInstruction: opts.system,
        tag: opts.tag,
      });
      const r = await gemini.submit(prompt, { model: opts.model, agent, systemInstruction: opts.system });
      store.setInteraction(id, r.interactionId, r.status);
      if (opts.watch) {
        // Under --watch the submit line is progress, not the answer, so it
        // goes to stderr -- `gemcatch research -w "..." > out.txt` then captures
        // only the result.
        if (!opts.json) console.error(edim(`Task ${id} submitted.`));
        await watchTask(store.getTask(id), DEFAULT_POLL_MS, opts.json);
        return;
      }
      emit(opts.json, { id, interaction_id: r.interactionId, status: r.status }, () =>
        console.log(`Task ${id} submitted. Run: gemcatch get ${id} when ready.`)
      );
    } catch (err) {
      // Only a failed *submit* should mark the task failed. Once it has an
      // interaction_id it is live on the server, and a later watch/poll error
      // must never overwrite it to failed -- that would drop it from the active
      // set and the daemon would abandon a task whose result is still coming.
      // Leave it active; the daemon (or a later `get`) collects it.
      if (id) {
        const t = store.getTask(id);
        if (!t || !t.interaction_id) store.setStatus(id, 'failed', { error: err.message });
      }
      die(err);
    }
  });

// --- batch ----------------------------------------------------------------

// Turn a prompts file into a list of prompts, plus a count of the lines it
// dropped so the caller can note them. Default: one per line, skipping blank
// lines and `#` comments. With --separator, split the whole file on that
// delimiter line instead, so a single prompt can span multiple lines.
//
// A `#` is a comment only when followed by whitespace (`# like this`). A line
// such as `#1 cause of X?` is a real prompt, not a comment, and must survive --
// treating every leading `#` as a comment silently swallowed those.
function parsePrompts(text, separator) {
  if (separator) {
    const blocks = [];
    let cur = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === separator) {
        blocks.push(cur.join('\n').trim());
        cur = [];
      } else {
        cur.push(line);
      }
    }
    blocks.push(cur.join('\n').trim());
    const prompts = blocks.filter(Boolean);
    return { prompts, skipped: blocks.length - prompts.length };
  }
  // The file almost always ends in a newline; that trailing empty line is not a
  // blank the user wrote, so it does not count towards the skipped tally.
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const prompts = [];
  let skipped = 0;
  for (const l of lines) {
    if (!l || /^#\s/.test(l)) skipped += 1;
    else prompts.push(l);
  }
  return { prompts, skipped };
}

// Poll just this batch until nothing tagged with it is still in flight, then
// tally the outcome. Modelled on syncPass (a bounded refresh pass) and
// watchTask (poll-until-terminal), but scoped to one tag.
async function watchBatch(tag, intervalMs, json) {
  const inFlight = () => store.listTasks({ tag }).filter((t) => t.interaction_id && !isDone(t.status));
  let pending = inFlight();
  let stalls = 0; // consecutive passes that resolved nothing
  while (pending.length) {
    // A poll that throws keeps the task's old status; the next pass retries it.
    // A 404 retires the task inside refresh, so it drops out of `inFlight`.
    await mapLimit(pending, 4, (t) => refresh(t).catch(() => {}));
    const next = inFlight();
    // Forward progress = the in-flight set shrank. A pass that resolves nothing
    // -- every poll erroring, or a wedged in_progress that never moves -- is a
    // stall; enough of those in a row means give up rather than loop forever.
    stalls = next.length < pending.length ? 0 : stalls + 1;
    pending = next;
    if (!pending.length) break;
    if (stalls >= WATCH_MAX_FAILS) {
      const msg = `Batch ${tag}: gave up after ${stalls} passes with no progress; ${pending.length} task(s) unresolved.`;
      emit(json, { tag, error: msg, unresolved: pending.length }, () => console.error(edim(msg)));
      process.exitCode = 1;
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const tasks = store.listTasks({ tag });
  const completed = tasks.filter((t) => isSuccess(t.status)).length;
  const failed = tasks.filter((t) => isDone(t.status) && !isSuccess(t.status)).length;
  emit(json, { tag, completed, failed, total: tasks.length }, () =>
    console.log(dim(`Batch ${tag}: ${completed}/${tasks.length} completed, ${failed} failed.`))
  );
}

program
  .command('batch')
  .argument('<file>', 'prompts file — one per line, or "-" to read stdin')
  .option('-m, --model <id>', 'model to use', gemini.DEFAULT_MODEL)
  .option('-a, --agent <id>', 'submit every prompt to a research agent instead of a model')
  .option('-s, --system <text>', 'system instruction')
  .option('-t, --tag <tag>', 'tag the whole batch (default: batch-<hex>)')
  .option('--separator <str>', 'split the file on this delimiter line for multi-line prompts')
  .option('-w, --watch', 'submit all, then poll until the whole batch finishes')
  .option('--yes', 'confirm the agent cost without asking (required when stdin is not a TTY)')
  .option('--dry-run', 'parse and list what would be submitted; submit nothing')
  .option('--json', 'machine-readable output')
  .description('submit many background tasks from a file, tagged as one batch')
  .action(async (file, opts, cmd) => {
    try {
      const agent = resolveAgentOpts(opts, cmd);
      const text = file === '-' ? await readStdin() : fs.readFileSync(file, 'utf8');
      const { prompts, skipped } = parsePrompts(text, opts.separator);
      if (!prompts.length) throw new Error(`no prompts found in ${file === '-' ? 'stdin' : file}`);
      // A one-line heads-up so a swallowed prompt (or a stray comment) is never a
      // silent mystery. Goes to stderr so it can't corrupt --json on stdout.
      if (skipped) {
        console.error(edim(`(skipped ${skipped} blank/comment line${skipped === 1 ? '' : 's'})`));
      }
      // Auto-tag so the batch is collectable as a unit; a user tag wins.
      const tag = opts.tag || `batch-${crypto.randomUUID().slice(0, 6)}`;

      if (opts.dryRun) {
        emit(opts.json, { tag, dry_run: true, agent: agent || null, prompts }, () => {
          if (agent) {
            // The whole point of the guard: N × the per-task band, up front.
            console.log(`${spendLine(agent, prompts.length)}. Nothing submitted (--dry-run).`);
          } else {
            console.log(`Batch ${tag}: ${prompts.length} prompt(s) would be submitted:`);
            for (const p of prompts) console.log(`  ${snippet(p)}`);
          }
        });
        return;
      }

      // An agent batch multiplies a per-task dollar band by the whole file, so
      // it is confirmed as one total before a single row is written.
      if (agent) await confirmSpend(agent, prompts.length, opts);

      // One failed submit must not sink the batch: mark that task failed and
      // keep going. mapLimit preserves input order, so the report is stable.
      const results = await mapLimit(prompts, 4, async (prompt) => {
        const id = store.createTask({ prompt, model: agent ? null : opts.model, agent, systemInstruction: opts.system, tag });
        try {
          const r = await gemini.submit(prompt, { model: opts.model, agent, systemInstruction: opts.system });
          store.setInteraction(id, r.interactionId, r.status);
          return { id, interaction_id: r.interactionId, status: r.status, prompt };
        } catch (err) {
          store.setStatus(id, 'failed', { error: err.message });
          return { id, interaction_id: null, status: 'failed', prompt, error: err.message };
        }
      });
      const submitted = results.filter((r) => !r.error);
      const failed = results.filter((r) => r.error);

      if (opts.watch) {
        // The submit lines are progress, not the answer, so they go to stderr.
        if (!opts.json) {
          console.error(`Batch ${tag}: submitted ${submitted.length} task(s)` + (failed.length ? `, ${failed.length} failed` : '') + '. Watching...');
        }
        await watchBatch(tag, DEFAULT_POLL_MS, opts.json);
        return;
      }

      emit(opts.json, { tag, submitted, failed }, () => {
        console.log(`Batch ${tag}: submitted ${submitted.length} task(s)` + (failed.length ? `, ${failed.length} failed` : '') + '.');
        for (const r of results) {
          const status = r.status || PENDING;
          // Pad before colouring: ANSI codes would break the column width.
          const pad = ' '.repeat(Math.max(0, 16 - status.length));
          console.log(`${r.id}  ${colorStatus(status)}${pad} ${snippet(r.prompt)}`);
        }
        console.log(dim('\nCollect them:'));
        console.log(dim('  gemcatch daemon --exit-when-idle'));
        console.log(dim(`  gemcatch list --tag ${tag} --status completed`));
      });
    } catch (err) {
      die(err);
    }
  });

// --- status ---------------------------------------------------------------

program
  .command('status')
  .argument('<id>', 'task id')
  .option('--json', 'machine-readable output')
  .description('poll the API and print the current state')
  .action(async (id, opts) => {
    const task = needTask(id);
    try {
      const { status } = await refresh(task);
      emit(opts.json, { id: task.id, status }, () =>
        console.log(`Task ${task.id}: ${colorStatus(status)}`)
      );
    } catch (err) {
      die(err);
    }
  });

// --- get ------------------------------------------------------------------

program
  .command('get')
  .argument('<id>', 'task id')
  .option('--json', 'machine-readable output')
  .option('--raw', 'print the raw interaction JSON from the API')
  .description('print the full response if complete, else the current status')
  .action(async (id, opts) => {
    const task = needTask(id);
    try {
      // Completed tasks are served from SQLite -- no network, and it still
      // works after the free tier drops the interaction at 24h. Gate on the
      // result being *present*, not truthy: a task that completes with empty
      // text stores `''`, which is exactly the case the cache must still serve
      // -- re-polling it would 404 after 24h, the very thing we cache to avoid.
      if (isSuccess(task.status) && task.result != null && !opts.raw) {
        const cits = parseCitations(task.citations);
        emit(opts.json, { id: task.id, status: task.status, result: task.result, citations: cits }, () =>
          console.log(withSources(task.result, cits))
        );
        return;
      }
      const r = await refresh(task);
      if (opts.raw) return console.log(JSON.stringify(r.raw, null, 2));
      if (isSuccess(r.status)) {
        emit(opts.json, { id: task.id, status: r.status, result: r.text, citations: r.citations || null }, () =>
          console.log(withSources(r.text, r.citations))
        );
      } else if (isDone(r.status)) {
        emit(opts.json, { id: task.id, status: r.status, error: r.text || null }, () =>
          console.log(`Task ${task.id}: ${colorStatus(r.status)}${r.text ? `\n${r.text}` : ''}`)
        );
        process.exitCode = 1;
      } else {
        emit(opts.json, { id: task.id, status: r.status, result: null }, () =>
          console.log(`Task ${task.id}: ${colorStatus(r.status)} — not ready yet. Try: gemcatch watch ${task.id}`)
        );
      }
    } catch (err) {
      die(err);
    }
  });

// --- list -----------------------------------------------------------------

program
  .command('list')
  .alias('ls')
  .addOption(new Option('--status <status>', 'only this status').choices(ALL_STATUSES))
  .option('-t, --tag <tag>', 'only this tag')
  .option('-n, --limit <n>', 'cap the number of rows', (v) => parseInt(v, 10))
  .option('--json', 'machine-readable output')
  .description('all tasks, newest first')
  .action((opts) => {
    // `-n 0` is a valid cap (show nothing); a negative would become SQLite's
    // "no limit" (LIMIT -1 = all rows), so reject anything but a non-negative int.
    if (opts.limit != null && (!Number.isInteger(opts.limit) || opts.limit < 0)) {
      return die(new Error(`--limit must be a non-negative integer (got ${opts.limit})`));
    }
    const tasks = store.listTasks({ status: opts.status, tag: opts.tag, limit: opts.limit });
    if (opts.json) return console.log(JSON.stringify(tasks, null, 2));
    if (!tasks.length) {
      console.log('No tasks yet. Submit one:  gemcatch research "your question"');
      return;
    }
    // The AGENT column only appears when something in the listing used one, so
    // a pure-model store keeps the compact four-column layout it always had.
    // Agent ids are shown compact -- the "-preview-MM-YYYY" suffix is version
    // noise in a table (the full id is in --json and in stats).
    const showAgent = tasks.some((t) => t.agent);
    const shortAgent = (a) => (a ? a.replace(/-preview-\d{2}-\d{4}$/, '') : '-');
    console.log(dim(`ID        AGE   STATUS           ${showAgent ? 'AGENT              ' : ''}PROMPT`));
    for (const t of tasks) {
      const snip = snippet(t.prompt);
      const status = t.status || PENDING;
      // Pad before colouring: ANSI codes would break the column width.
      const pad = ' '.repeat(Math.max(0, 16 - status.length));
      const agentCol = showAgent ? `${shortAgent(t.agent).padEnd(18)} ` : '';
      console.log(
        `${t.id}  ${age(t.created_at).padEnd(4)}  ${colorStatus(status)}${pad} ${agentCol}${snip}`
      );
    }
  });

// --- export ---------------------------------------------------------------

// Collect many finished results into one document -- the "gather" that pairs
// with `batch`'s "scatter". Where `get` prints one result at a time, `export`
// concatenates a whole tag (or status) under prompt headings, to stdout or a
// file, as Markdown (default) or JSON.
program
  .command('export')
  .option('-t, --tag <tag>', 'only this tag')
  .addOption(new Option('--status <status>', 'only this status').choices(ALL_STATUSES).default('completed'))
  .addOption(new Option('--format <fmt>', 'output format').choices(['md', 'json']).default('md'))
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .description('concatenate finished results, each under its prompt, to stdout or a file')
  .action((opts) => {
    const tasks = store.listTasks({ tag: opts.tag, status: opts.status });
    // Newest-first suits a listing, but an export reads top-to-bottom like a
    // document, so oldest-first is the natural order here.
    tasks.reverse();
    // Only rows that actually carry a result are worth exporting: a status
    // filter other than `completed` can match tasks that never stored text.
    const rows = tasks.filter((t) => t.result != null);
    if (!rows.length) {
      // Nothing to write isn't an error, but say why so an empty -o file (or an
      // empty pipe) isn't a mystery. The note goes to stderr, never the output.
      console.error(`No ${opts.status} results to export${opts.tag ? ` for tag '${opts.tag}'` : ''}.`);
      return;
    }

    let output;
    if (opts.format === 'json') {
      output = JSON.stringify(
        rows.map((t) => ({
          id: t.id,
          tag: t.tag,
          status: t.status,
          prompt: t.prompt,
          result: t.result,
          created_at: t.created_at,
        })),
        null,
        2
      );
    } else {
      output = rows
        .map((t) => {
          const when = new Date(t.created_at).toISOString().replace('T', ' ').slice(0, 16);
          const head = (t.prompt || '(no prompt)').replace(/\s+/g, ' ').trim();
          const body = t.result && t.result.trim() ? t.result : '_(empty result)_';
          return `## ${head}\n\n\`${t.id}\` · ${t.status} · ${when} UTC\n\n${body}`;
        })
        .join('\n\n---\n\n');
    }

    if (opts.out) {
      fs.writeFileSync(opts.out, output.endsWith('\n') ? output : `${output}\n`);
      console.error(`Wrote ${rows.length} result(s) to ${opts.out}.`);
    } else {
      console.log(output);
    }
  });

// --- digest ---------------------------------------------------------------

// One step past `export`: instead of concatenating a tag's results, feed them
// back through a single Gemini call and synthesise one summary. It is `research`
// with a prompt built from what you have already collected, so it submits, then
// watches to completion just like `research -w`.
program
  .command('digest')
  .requiredOption('-t, --tag <tag>', 'synthesize the completed results under this tag')
  .option('-m, --model <id>', 'model to use', gemini.DEFAULT_MODEL)
  .option('-s, --system <text>', 'system instruction for the synthesis')
  .option('--json', 'machine-readable output')
  .description("feed a tag's completed results through one Gemini call into a single summary")
  .action(async (opts) => {
    let id;
    try {
      const done = store
        .listTasks({ tag: opts.tag, status: 'completed' })
        .filter((t) => t.result != null && t.result.trim());
      if (!done.length) {
        throw new Error(
          `no completed results tagged '${opts.tag}' to digest.` +
            ' Collect them first: gemcatch daemon --exit-when-idle'
        );
      }
      done.reverse(); // oldest first, so the sources read in submission order
      const sources = done
        .map((t, i) => `## Source ${i + 1}: ${(t.prompt || '').replace(/\s+/g, ' ').trim()}\n\n${t.result}`)
        .join('\n\n');
      const prompt =
        `Synthesize the following ${done.length} research result(s) into one coherent summary.` +
        ' Note where they agree and disagree, and do not simply repeat each verbatim.\n\n' +
        sources;
      // The digest is itself a task, tagged so it is findable but kept out of
      // the source tag so a later digest never digests its own output.
      id = store.createTask({ prompt, model: opts.model, systemInstruction: opts.system, tag: `${opts.tag}-digest` });
      const r = await gemini.submit(prompt, { model: opts.model, systemInstruction: opts.system });
      store.setInteraction(id, r.interactionId, r.status);
      if (!opts.json) console.error(edim(`Digesting ${done.length} result(s) tagged ${opts.tag} -> task ${id}.`));
      await watchTask(store.getTask(id), DEFAULT_POLL_MS, opts.json);
    } catch (err) {
      // Same rule as `research`: only a failed *submit* marks the task failed.
      if (id) {
        const t = store.getTask(id);
        if (!t || !t.interaction_id) store.setStatus(id, 'failed', { error: err.message });
      }
      die(err);
    }
  });

// --- sync -----------------------------------------------------------------

// One refresh pass over everything in flight. Never throws: a task that fails
// to poll reports its error and keeps its old status, and the rest carry on.
// Shared by `sync` (one pass) and `daemon` (a pass every interval).
async function syncPass() {
  return mapLimit(store.activeTasks(), 4, async (t) => {
    try {
      const r = await refresh(t);
      return { id: t.id, status: r.status, changed: r.status !== t.status };
    } catch (err) {
      return { id: t.id, status: t.status, error: err.message, changed: false };
    }
  });
}

program
  .command('sync')
  .option('--json', 'machine-readable output')
  .description('refresh every in-flight task in one pass')
  .action(async (opts) => {
    const results = await syncPass();
    if (!results.length) {
      emit(opts.json, { refreshed: [] }, () => console.log('Nothing in flight.'));
      return;
    }
    emit(opts.json, { refreshed: results }, () => {
      for (const r of results) {
        console.log(`${r.id}  ${colorStatus(r.status)}${r.error ? `  ${dim(r.error)}` : ''}`);
      }
      const done = results.filter((r) => isDone(r.status)).length;
      console.log(dim(`\n${results.length} refreshed, ${done} finished.`));
    });
  });

// --- daemon ---------------------------------------------------------------

program
  .command('daemon')
  .option('-i, --interval <seconds>', 'seconds between passes', (v) => parseFloat(v), DEFAULT_DAEMON_S)
  .option('--exit-when-idle', 'stop once nothing is left in flight')
  .option('--json', 'newline-delimited JSON events on stdout')
  .description('poll in-flight tasks on a loop so results are cached before they expire')
  .action(async (opts) => {
    if (!Number.isFinite(opts.interval) || opts.interval <= 0) {
      return die(new Error(`--interval must be a positive number of seconds (got ${opts.interval})`));
    }
    const intervalMs = Math.max(1000, opts.interval * 1000);
    let stopping = false;
    let wake = null;
    // Finish the pass in progress, then exit cleanly -- never leave a polled
    // result unwritten because someone hit Ctrl-C. A *second* signal, though,
    // means "I don't want to wait for this pass" -- force-exit immediately with
    // the conventional 130 (128 + SIGINT) so a long paced pass can't trap you.
    const stop = () => {
      if (stopping) process.exit(130);
      stopping = true;
      if (wake) wake();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    const event = (o) => {
      if (opts.json) console.log(JSON.stringify(o));
    };

    if (!opts.json) {
      console.error(
        edim(`gemcatch daemon: polling every ${intervalMs / 1000}s. Store: ${store.DB_PATH}. Ctrl-C to stop.`)
      );
    }
    event({ event: 'start', interval_s: intervalMs / 1000, db: store.DB_PATH });

    for (;;) {
      let pass = [];
      try {
        pass = await syncPass();
      } catch (err) {
        // syncPass swallows per-task failures, so reaching here means the store
        // itself is unhappy (locked, full disk). Report it and keep looping --
        // the next pass may well succeed, and a daemon that dies silently is
        // worse than one that complains.
        if (opts.json) event({ event: 'error', error: err.message });
        else console.error(`${edim(`[${hhmmss()}]`)} Error: ${err.message}`);
      }

      // Quiet by default: only transitions and failures are worth a line.
      for (const r of pass) {
        if (!r.changed && !r.error) continue;
        if (opts.json) {
          event({ event: r.error ? 'error' : 'update', id: r.id, status: r.status, error: r.error || null });
        } else {
          console.error(
            edim(`[${hhmmss()}] ${r.id}: `) + ecolorStatus(r.status) + (r.error ? `  ${edim(r.error)}` : '')
          );
        }
      }

      if (stopping) break;
      if (opts.exitWhenIdle && !pass.some((r) => !isDone(r.status))) break;

      await new Promise((resolve) => {
        const t = setTimeout(() => {
          wake = null;
          resolve();
        }, intervalMs);
        wake = () => {
          clearTimeout(t);
          wake = null;
          resolve();
        };
      });
      if (stopping) break;
    }

    event({ event: 'stop' });
    if (!opts.json) console.error(edim('gemcatch daemon: stopped.'));
    store.close();
  });

// --- watch ----------------------------------------------------------------

async function watchTask(task, intervalMs, json) {
  let last = null;
  let fails = 0;
  for (;;) {
    let r;
    try {
      r = await refresh(task);
      fails = 0; // a clean poll resets the failure run
    } catch (err) {
      // A poll error must not sink a live task: keep its old status and try
      // again next interval, exactly like watchBatch. Give up only once the
      // failures pile up, so a task the server can't answer for can't hang the
      // watch forever. (A 404 doesn't reach here -- refresh retires it and
      // returns a terminal status, handled below.)
      fails += 1;
      if (fails >= WATCH_MAX_FAILS) {
        const msg = `Gave up watching ${task.id} after ${fails} consecutive poll failures: ${err.message}`;
        emit(json, { id: task.id, status: task.status, error: msg }, () => console.error(edim(msg)));
        process.exitCode = 1;
        return;
      }
      await new Promise((r2) => setTimeout(r2, intervalMs));
      continue;
    }
    // Status chatter goes to stderr so `gemcatch watch x > out.txt` captures only
    // the result.
    if (r.status !== last && !json) {
      console.error(edim(`[${new Date().toISOString().slice(11, 19)}] ${task.id}: `) + ecolorStatus(r.status));
      last = r.status;
    }
    if (isSuccess(r.status)) {
      emit(json, { id: task.id, status: r.status, result: r.text, citations: r.citations || null }, () =>
        console.log(withSources(r.text, r.citations))
      );
      return;
    }
    if (isDone(r.status)) {
      emit(json, { id: task.id, status: r.status, error: r.text || null }, () => {
        console.error(`Task ${task.id} ended: ${ecolorStatus(r.status)}`);
        if (r.text) console.log(r.text);
      });
      process.exitCode = 1;
      return;
    }
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
}

program
  .command('watch')
  .argument('<id>', 'task id')
  .option('-i, --interval <seconds>', 'poll interval', (v) => parseFloat(v))
  .option('--json', 'machine-readable output')
  .description('poll until the task finishes, then print the result')
  .action(async (id, opts) => {
    const task = needTask(id);
    try {
      // Serve a completed result from cache -- present, not merely truthy, so an
      // empty-text completion is served instead of re-polled (and lost at 24h).
      if (isSuccess(task.status) && task.result != null) {
        const cits = parseCitations(task.citations);
        emit(opts.json, { id: task.id, status: task.status, result: task.result, citations: cits }, () =>
          console.log(withSources(task.result, cits))
        );
        return;
      }
      if (opts.interval != null && (!Number.isFinite(opts.interval) || opts.interval <= 0)) {
        return die(new Error(`--interval must be a positive number of seconds (got ${opts.interval})`));
      }
      await watchTask(task, opts.interval ? opts.interval * 1000 : DEFAULT_POLL_MS, opts.json);
    } catch (err) {
      die(err);
    }
  });

// --- cancel ---------------------------------------------------------------

program
  .command('cancel')
  .argument('<id>', 'task id')
  .description('ask the API to stop an in-flight task')
  .action(async (id) => {
    const task = needTask(id);
    if (!task.interaction_id) return die(new Error(`Task ${task.id} was never submitted.`));
    if (isDone(task.status)) return die(new Error(`Task ${task.id} already ${task.status}.`));
    try {
      const r = await gemini.cancel(task.interaction_id);
      store.setStatus(task.id, r.status);
      console.log(`Task ${task.id}: ${colorStatus(r.status)}`);
    } catch (err) {
      die(err);
    }
  });

// --- rm -------------------------------------------------------------------

program
  .command('rm')
  .argument('<ids...>', 'task ids')
  .option('--remote', 'also delete the interaction server-side')
  .description('forget tasks locally')
  .action(async (ids, opts) => {
    let removed = 0;
    for (const raw of ids) {
      const task = needTask(raw);
      if (opts.remote && task.interaction_id) {
        try {
          await gemini.remove(task.interaction_id);
        } catch (err) {
          // Free-tier interactions vanish after 24h, so a missing remote is
          // normal -- never block the local delete on it.
          console.error(edim(`  (remote delete failed for ${task.id}: ${err.message})`));
        }
      }
      if (store.removeTask(task.id)) removed += 1;
    }
    console.log(`Removed ${removed} task${removed === 1 ? '' : 's'}.`);
  });

// --- prune ----------------------------------------------------------------

program
  .command('prune')
  .option('-d, --days <n>', 'only finished tasks older than n days', (v) => parseFloat(v), 30)
  .option('--dry-run', 'list what would go, delete nothing')
  .description('drop old finished tasks (in-flight work is never touched)')
  .action((opts) => {
    // A negative (or non-numeric) --days puts the cutoff in the *future*, which
    // would match every finished task and quietly wipe the lot. Refuse it: the
    // cutoff must be at or before now.
    if (!Number.isFinite(opts.days) || opts.days < 0) {
      return die(new Error(`--days must be a non-negative number (got ${opts.days})`));
    }
    const cutoff = Date.now() - opts.days * 86400000;
    const doomed = store.prunableTasks(cutoff);
    if (!doomed.length) {
      console.log(`Nothing finished is older than ${opts.days} days.`);
      return;
    }
    if (opts.dryRun) {
      for (const t of doomed) console.log(`${t.id}  ${age(t.created_at)}  ${t.status}`);
      console.log(dim(`\n${doomed.length} task(s) would be removed.`));
      return;
    }
    const n = store.removeMany(doomed.map((t) => t.id));
    console.log(`Pruned ${n} task${n === 1 ? '' : 's'}.`);
  });

// --- stats ----------------------------------------------------------------

program
  .command('stats')
  .option('--json', 'machine-readable output')
  .description('where the store lives and what is in it')
  .action((opts) => {
    const rows = store.counts();
    const agents = store.agentCounts();
    const total = rows.reduce((n, r) => n + r.n, 0);
    emit(opts.json, { db: store.DB_PATH, total, by_status: rows, by_agent: agents }, () => {
      console.log(`Store: ${store.DB_PATH}`);
      console.log(`Tasks: ${total}`);
      for (const r of rows) console.log(`  ${colorStatus(r.status).padEnd(useColor ? 26 : 17)} ${r.n}`);
      if (agents.length) {
        console.log('Agent runs:');
        for (const a of agents) console.log(`  ${a.agent.padEnd(34)} ${a.n}`);
      }
    });
  });

// Close the store on the way out so a one-shot command doesn't leave the
// SQLite -wal/-shm sidecars lingering. The store opens lazily, so if a command
// never touched it this is a no-op; the daemon closes explicitly too, and a
// second close is harmless.
process.on('exit', () => {
  try {
    store.close();
  } catch (_) {
    /* best effort on the way out */
  }
});

program.parseAsync(process.argv).catch(die);
