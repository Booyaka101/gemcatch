#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { Command, Option } = require('commander');
const store = require('./db');
const gemini = require('./gemini');
const { TERMINAL, ACTIVE, PENDING, isDone, isSuccess } = require('./status');

const DEFAULT_POLL_MS = Number(process.env.GEMCATCH_POLL_MS) || 10000;
// Free-tier results are dropped after 24h, so the daemon only has to be
// comfortably faster than that. Five minutes is far inside the margin and
// costs a handful of requests an hour.
const DEFAULT_DAEMON_S = Number(process.env.GEMCATCH_DAEMON_S) || 300;
const ALL_STATUSES = [PENDING].concat(ACTIVE, TERMINAL);

// --- output ---------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const dim = (s) => paint('2', s);

function colorStatus(s) {
  if (isSuccess(s)) return paint('32', s); // green
  if (s === 'in_progress' || s === PENDING) return paint('36', s); // cyan
  if (s === 'requires_action') return paint('33', s); // yellow
  return paint('31', s); // red: failed/cancelled/incomplete/budget_exceeded
}

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
  const r = await gemini.poll(task.interaction_id);
  const extra = {};
  if (isDone(r.status)) {
    if (isSuccess(r.status)) extra.result = r.text;
    else if (r.text) extra.error = r.text;
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
  .option('-s, --system <text>', 'system instruction')
  .option('-t, --tag <tag>', 'label for filtering with `gemcatch list --tag`')
  .option('-w, --watch', 'wait for the result instead of exiting')
  .option('--json', 'machine-readable output')
  .description('submit a background task and exit immediately')
  .action(async (promptArg, opts) => {
    let id;
    try {
      const prompt = await resolvePrompt(promptArg, opts);
      id = store.createTask({
        prompt,
        model: opts.model,
        systemInstruction: opts.system,
        tag: opts.tag,
      });
      const r = await gemini.submit(prompt, { model: opts.model, systemInstruction: opts.system });
      store.setInteraction(id, r.interactionId, r.status);
      if (opts.watch) {
        // Under --watch the submit line is progress, not the answer, so it
        // goes to stderr -- `gemcatch research -w "..." > out.txt` then captures
        // only the result.
        if (!opts.json) console.error(dim(`Task ${id} submitted.`));
        await watchTask(store.getTask(id), DEFAULT_POLL_MS, opts.json);
        return;
      }
      emit(opts.json, { id, interaction_id: r.interactionId, status: r.status }, () =>
        console.log(`Task ${id} submitted. Run: gemcatch get ${id} when ready.`)
      );
    } catch (err) {
      if (id) store.setStatus(id, 'failed', { error: err.message });
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
      // works after the free tier drops the interaction at 24h.
      if (isSuccess(task.status) && task.result && !opts.raw) {
        emit(opts.json, { id: task.id, status: task.status, result: task.result }, () =>
          console.log(task.result)
        );
        return;
      }
      const r = await refresh(task);
      if (opts.raw) return console.log(JSON.stringify(r.raw, null, 2));
      if (isSuccess(r.status)) {
        emit(opts.json, { id: task.id, status: r.status, result: r.text }, () =>
          console.log(r.text || '(empty response)')
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
    const tasks = store.listTasks({ status: opts.status, tag: opts.tag, limit: opts.limit });
    if (opts.json) return console.log(JSON.stringify(tasks, null, 2));
    if (!tasks.length) {
      console.log('No tasks yet. Submit one:  gemcatch research "your question"');
      return;
    }
    console.log(dim('ID        AGE   STATUS           PROMPT'));
    for (const t of tasks) {
      const prompt = (t.prompt || '').replace(/\s+/g, ' ');
      const snip = prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
      const status = t.status || PENDING;
      // Pad before colouring: ANSI codes would break the column width.
      const pad = ' '.repeat(Math.max(0, 16 - status.length));
      console.log(
        `${t.id}  ${age(t.created_at).padEnd(4)}  ${colorStatus(status)}${pad} ${snip}`
      );
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
    const intervalMs = Math.max(1000, (opts.interval || DEFAULT_DAEMON_S) * 1000);
    let stopping = false;
    let wake = null;
    // Finish the pass in progress, then exit cleanly -- never leave a polled
    // result unwritten because someone hit Ctrl-C.
    const stop = () => {
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
        dim(`gemcatch daemon: polling every ${intervalMs / 1000}s. Store: ${store.DB_PATH}. Ctrl-C to stop.`)
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
        else console.error(`${dim(`[${hhmmss()}]`)} Error: ${err.message}`);
      }

      // Quiet by default: only transitions and failures are worth a line.
      for (const r of pass) {
        if (!r.changed && !r.error) continue;
        if (opts.json) {
          event({ event: r.error ? 'error' : 'update', id: r.id, status: r.status, error: r.error || null });
        } else {
          console.error(
            dim(`[${hhmmss()}] ${r.id}: `) + colorStatus(r.status) + (r.error ? `  ${dim(r.error)}` : '')
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
    if (!opts.json) console.error(dim('gemcatch daemon: stopped.'));
    store.close();
  });

// --- watch ----------------------------------------------------------------

async function watchTask(task, intervalMs, json) {
  let last = null;
  for (;;) {
    const r = await refresh(task);
    // Status chatter goes to stderr so `gemcatch watch x > out.txt` captures only
    // the result.
    if (r.status !== last && !json) {
      console.error(dim(`[${new Date().toISOString().slice(11, 19)}] ${task.id}: `) + colorStatus(r.status));
      last = r.status;
    }
    if (isSuccess(r.status)) {
      emit(json, { id: task.id, status: r.status, result: r.text }, () =>
        console.log(r.text || '(empty response)')
      );
      return;
    }
    if (isDone(r.status)) {
      emit(json, { id: task.id, status: r.status, error: r.text || null }, () => {
        console.error(`Task ${task.id} ended: ${colorStatus(r.status)}`);
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
      if (isSuccess(task.status) && task.result) {
        emit(opts.json, { id: task.id, status: task.status, result: task.result }, () =>
          console.log(task.result)
        );
        return;
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
          console.error(dim(`  (remote delete failed for ${task.id}: ${err.message})`));
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
    const total = rows.reduce((n, r) => n + r.n, 0);
    emit(opts.json, { db: store.DB_PATH, total, by_status: rows }, () => {
      console.log(`Store: ${store.DB_PATH}`);
      console.log(`Tasks: ${total}`);
      for (const r of rows) console.log(`  ${colorStatus(r.status).padEnd(useColor ? 26 : 17)} ${r.n}`);
    });
  });

program.parseAsync(process.argv).catch(die);
