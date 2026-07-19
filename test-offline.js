'use strict';

/**
 * Drives the real CLI end-to-end against a mock Interactions API.
 *
 * Covers what a live key would otherwise be needed for: the success path
 * (in_progress -> completed -> text), cancellation, deletion and sync.
 * Runs against the raw-fetch fallback via GEMCATCH_FORCE_REST=1, which also
 * exercises step-based text extraction -- REST responses carry no
 * output_text (the SDK synthesises that field).
 *
 * No network, no key, no tokens spent.
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const ANSWER = 'This week in AI: the Interactions API shipped background execution.';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcatch-test-'));

let seq = 0;
let getHits = 0;
let keyRejects = 0;
let flaky503s = 0;
const interactions = new Map(); // id -> {status, pollsLeft, text, model, system, deleted}

// --- mock Interactions API ------------------------------------------------

const server = http.createServer((req, res) => {
  const send = (code, body, headers) => {
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers || {}));
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  if (req.headers['x-goog-api-key'] !== 'TEST_KEY') {
    keyRejects += 1;
    return send(400, [{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }]);
  }

  const url = decodeURIComponent(req.url);
  const idPart = url.replace('/interactions', '').replace(/^\//, '');

  // create
  if (req.method === 'POST' && !idPart) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.strictEqual(body.background, true, 'background must be true');
      assert.strictEqual(typeof body.input, 'string', 'input must be a plain string');
      const id = `int_${++seq}`;
      interactions.set(id, {
        status: 'in_progress',
        prompt: body.input,
        // SLOW stays in_progress for a couple of polls; FAIL and FLAKY resolve
        // on the first successful one so both paths are reachable in a single
        // `get`.
        pollsLeft: /SLOW/.test(body.input) ? 2 : /FAIL|FLAKY/.test(body.input) ? 0 : 1,
        text: /FAIL/.test(body.input) ? '' : ANSWER,
        fails: /FAIL/.test(body.input),
        // FLAKY answers the first two polls with a 503 before behaving.
        flakyLeft: /FLAKY/.test(body.input) ? 2 : 0,
        model: body.model,
        system: body.system_instruction,
      });
      send(200, { id, status: 'in_progress' });
    });
    return;
  }

  // cancel
  if (req.method === 'POST' && idPart.endsWith(':cancel')) {
    const id = idPart.replace(':cancel', '');
    const it = interactions.get(id);
    if (!it) return send(404, { error: { code: 404, message: 'not found' } });
    it.status = 'cancelled';
    return send(200, { id, status: 'cancelled' });
  }

  // delete
  if (req.method === 'DELETE') {
    if (!interactions.delete(idPart)) return send(404, { error: { code: 404, message: 'not found' } });
    return send(200, {});
  }

  // poll
  if (req.method === 'GET') {
    getHits += 1;
    const it = interactions.get(idPart);
    if (!it) return send(404, { error: { code: 404, message: 'Interaction not found.' } });
    // Retry-After: 0 keeps the suite fast while still exercising the header.
    if (it.flakyLeft > 0) {
      it.flakyLeft -= 1;
      flaky503s += 1;
      return send(
        503,
        { error: { code: 503, message: 'The model is overloaded. Please try again later.' } },
        { 'Retry-After': '0' }
      );
    }
    if (it.status === 'in_progress' && it.pollsLeft > 0) {
      it.pollsLeft -= 1;
      return send(200, { id: idPart, status: 'in_progress' });
    }
    if (it.status === 'cancelled') return send(200, { id: idPart, status: 'cancelled' });
    if (it.fails) return send(200, { id: idPart, status: 'failed', usage: { total_tokens: 3 } });
    // No output_text on REST: text must be recovered from steps. The real API
    // interleaves the echoed prompt and the model's reasoning with the answer,
    // so the mock does too -- only the model_output text may come back.
    return send(200, {
      id: idPart,
      status: 'completed',
      usage: { total_tokens: 42 },
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: it.prompt || 'echoed prompt' }] },
        { type: 'thought', signature: 'redacted' },
        { type: 'model_output', content: { parts: [{ text: it.text }] } },
      ],
    });
  }
  send(405, { error: { code: 405, message: 'method not allowed' } });
});

// --- harness --------------------------------------------------------------

function testEnv(extra) {
  return Object.assign(
    {},
    process.env,
    {
      GEMCATCH_HOME: HOME,
      GEMCATCH_FORCE_REST: '1',
      GEMCATCH_BASE_URL: `http://127.0.0.1:${server.address().port}/interactions`,
      GEMINI_API_KEY: 'TEST_KEY',
      GEMCATCH_POLL_MS: '30',
      // The real default (15/min) would pace this suite to a crawl. The
      // limiter has its own test below, which switches it back on.
      GEMCATCH_RPM: '0',
      NO_COLOR: '1',
    },
    extra || {}
  );
}

function cli(args, extra) {
  const o = extra || {};
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'index.js')].concat(args), {
      env: testEnv(o.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      const r = { stdout, stderr, code };
      if (code === 0) return resolve(r);
      const e = new Error(`exit ${code}: ${stderr.trim()}`);
      Object.assign(e, r);
      reject(e);
    });
    child.stdin.end(o.stdin === undefined ? '' : o.stdin);
  });
}

const out = async (args, extra) => (await cli(args, extra)).stdout;
const idOf = (text) => (text.match(/^Task (\w+) submitted\./m) || [])[1];
const ok = (name) => console.log(`  ok  ${name}`);

async function submit(prompt, args, extra) {
  const text = await out(['research', prompt].concat(args || []), extra);
  const id = idOf(text);
  assert(id, `expected a task id, got: ${text}`);
  return id;
}

// --- suite ----------------------------------------------------------------

(async () => {
  // ---- pure helpers ----
  const gemini = require('./gemini');
  const status = require('./status');

  assert.strictEqual(gemini.textOf({ output_text: 'hi' }), 'hi');
  assert.strictEqual(gemini.textOf({ steps: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }), 'a\nb');
  assert.strictEqual(gemini.textOf({ steps: [] }), '');
  assert.strictEqual(gemini.textOf({}), '');
  // Only model_output is the answer: the echoed prompt and the reasoning are
  // skipped, or they get prepended to the result (real bug, seen live).
  assert.strictEqual(
    gemini.textOf({
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'the prompt' }] },
        { type: 'thought', content: [{ type: 'text', text: 'let me think' }] },
        { type: 'model_output', content: { parts: [{ text: 'the answer' }] } },
      ],
    }),
    'the answer'
  );
  ok('textOf prefers output_text, falls back to steps');

  // A 4xx is a bad request and will fail identically forever; retrying it just
  // wastes the user's rate limit. Everything transient gets another go.
  for (const s of [408, 429, 500, 502, 503, 504]) {
    assert.strictEqual(gemini.shouldRetry({ httpStatus: s }), true, `${s} should retry`);
  }
  for (const s of [400, 401, 403, 404]) {
    assert.strictEqual(gemini.shouldRetry({ httpStatus: s }), false, `${s} should not retry`);
  }
  assert.strictEqual(gemini.shouldRetry({ code: 'NETWORK' }), true, 'network blips retry');
  assert.strictEqual(gemini.shouldRetry({ code: 'NO_KEY' }), false, 'a missing key is not transient');
  ok('retry policy: transient failures yes, client errors no');

  for (const s of status.TERMINAL) assert.strictEqual(status.isDone(s), true, `${s} terminal`);
  for (const s of status.ACTIVE) assert.strictEqual(status.isDone(s), false, `${s} active`);
  assert.strictEqual(status.isSuccess('completed'), true);
  assert.strictEqual(status.isSuccess('failed'), false);
  ok('status helpers match the SDK InteractionStatus union');

  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // ---- v1 -> v2 migration ----
  const legacy = path.join(HOME, 'legacy');
  fs.mkdirSync(legacy, { recursive: true });
  const legacyDb = new Database(path.join(legacy, 'tasks.db'));
  legacyDb.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT, interaction_id TEXT, status TEXT DEFAULT 'pending', result TEXT, created_at INTEGER)"
  );
  legacyDb.prepare('INSERT INTO tasks (id, prompt, status, created_at) VALUES (?,?,?,?)').run('old00001', 'legacy row', 'completed', 1);
  legacyDb.close();
  const migrated = (await out(['list'], { env: { GEMCATCH_HOME: legacy } }));
  assert(migrated.includes('old00001'), `legacy row should survive migration: ${migrated}`);
  const cols = new Database(path.join(legacy, 'tasks.db')).prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  for (const c of ['model', 'tag', 'usage', 'updated_at', 'error', 'system_instruction']) {
    assert(cols.includes(c), `migration should add ${c}`);
  }
  ok('a v1 tasks.db migrates in place without losing rows');

  // ---- research ----
  const t0 = Date.now();
  const first = await out(['research', 'summarize this week in AI', '--tag', 'ai']);
  const elapsed = Date.now() - t0;
  const id = idOf(first);
  assert(id, `expected submit line, got: ${first}`);
  assert(first.includes(`Run: gemcatch get ${id} when ready.`), 'exact brief wording');
  assert(elapsed < 3000, `research must exit <3s, took ${elapsed}ms`);
  ok(`research submitted ${id} in ${elapsed}ms and exited`);

  // ---- research --json / --model / --system ----
  const j = JSON.parse(await out(['research', 'json please', '--json', '--model', 'gemini-3.1-flash', '--system', 'be terse']));
  assert(j.id && j.interaction_id && j.status === 'in_progress', `bad json: ${JSON.stringify(j)}`);
  const rec = interactions.get(j.interaction_id);
  assert.strictEqual(rec.model, 'gemini-3.1-flash', '--model must reach the API');
  assert.strictEqual(rec.system, 'be terse', '--system must reach the API');
  ok('research --json emits ids; --model/--system reach the API');

  // ---- default model ----
  const dflt = JSON.parse(await out(['research', 'default model', '--json']));
  assert.strictEqual(interactions.get(dflt.interaction_id).model, 'gemini-3.1-flash-lite', 'default model');
  ok('default model is gemini-3.1-flash-lite');

  // ---- stdin + --file ----
  const viaStdin = idOf(await out(['research', '-'], { stdin: 'prompt from stdin' }));
  assert(viaStdin, 'stdin prompt should submit');
  const pf = path.join(HOME, 'p.txt');
  fs.writeFileSync(pf, 'prompt from file');
  const viaFile = idOf(await out(['research', '--file', pf]));
  assert(viaFile, '--file prompt should submit');
  const listed = await out(['list']);
  assert(listed.includes('prompt from stdin') && listed.includes('prompt from file'), 'both prompts stored');
  ok('research reads a prompt from stdin ("-") and from --file');

  // ---- empty prompt ----
  await assert.rejects(() => cli(['research']), /provide a prompt/, 'bare research should explain itself');
  ok('research with no prompt fails with a useful message');

  // ---- status ----
  assert((await out(['status', id])).includes('in_progress'), 'status should report in_progress');
  ok('status reports in_progress while running');

  // ---- get: completes, then serves from cache ----
  assert.strictEqual((await out(['get', id])).trim(), ANSWER, 'second poll flips to completed');
  const before = getHits;
  assert.strictEqual((await out(['get', id])).trim(), ANSWER, 'cached read');
  assert.strictEqual(getHits, before, 'completed result must come from SQLite, not the API');
  ok('get returns the text, then serves it from SQLite without re-polling');

  // ---- usage captured ----
  const raw = new Database(path.join(HOME, 'tasks.db')).prepare('SELECT usage FROM tasks WHERE id = ?').get(id);
  assert.strictEqual(JSON.parse(raw.usage).total_tokens, 42, 'usage should be stored');
  ok('token usage is recorded');

  // ---- id prefix ----
  assert.strictEqual((await out(['get', id.slice(0, 4)])).trim(), ANSWER, 'prefix lookup');
  ok('any unique id prefix resolves');

  // ---- list filters ----
  const jl = JSON.parse(await out(['list', '--json', '--tag', 'ai']));
  assert.strictEqual(jl.length, 1, 'tag filter');
  assert.strictEqual(jl[0].id, id);
  assert.strictEqual((JSON.parse(await out(['list', '--json', '-n', '2']))).length, 2, 'limit');
  assert((await out(['list', '--status', 'completed'])).includes(id), 'status filter');
  ok('list filters by --tag, --status and -n');

  // ---- sync ----
  const slow = await submit('SLOW one');
  const syncJson = JSON.parse(await out(['sync', '--json']));
  assert(syncJson.refreshed.some((r) => r.id === slow), 'sync should refresh in-flight tasks');
  assert(!syncJson.refreshed.some((r) => r.id === id), 'sync must skip finished tasks');
  ok('sync refreshes only in-flight tasks');

  // ---- watch ----
  const w = await submit('SLOW watch me');
  assert.strictEqual((await out(['watch', w, '-i', '0.05'])).trim(), ANSWER, 'watch prints the result');
  ok('watch polls until complete then prints the result');

  // ---- research --watch ----
  // The README promises `gemcatch research -w "..." > out.txt` captures only the
  // answer, so stdout must carry the result and nothing else.
  const rw = await cli(['research', 'SLOW watch inline', '-w']);
  assert.strictEqual(rw.stdout.trim(), ANSWER, `stdout must be answer-only: ${JSON.stringify(rw.stdout)}`);
  assert(/submitted/.test(rw.stderr), 'the submit line belongs on stderr under --watch');
  ok('research --watch puts the result on stdout and progress on stderr');

  // ---- research --watch --json ----
  const rwj = JSON.parse((await cli(['research', 'SLOW watch json', '-w', '--json'])).stdout);
  assert.strictEqual(rwj.result, ANSWER, 'json watch should emit one final object');
  assert.strictEqual(rwj.status, 'completed');
  ok('research --watch --json emits a single final result object');

  // ---- retry on a transient 503 ----
  const flaky = await submit('FLAKY please');
  const before503 = flaky503s;
  assert.strictEqual((await out(['get', flaky])).trim(), ANSWER, 'a transient 503 must not reach the user');
  assert.strictEqual(flaky503s - before503, 2, 'both 503s should have been retried through');
  ok('a transient 503 is retried with backoff until it succeeds');

  // ---- rate limiter ----
  // 60/min is one request per second, so three in-flight polls in a single
  // `sync` cannot finish faster than ~2s. That gap is what proves the pacing
  // is real rather than the fan-out merely being slow.
  const rlHome = path.join(HOME, 'ratelimit');
  const rlEnv = { GEMCATCH_HOME: rlHome };
  for (const p of ['SLOW rl one', 'SLOW rl two', 'SLOW rl three']) await submit(p, [], { env: rlEnv });
  const rlStart = Date.now();
  await out(['sync'], { env: Object.assign({}, rlEnv, { GEMCATCH_RPM: '60' }) });
  const rlTook = Date.now() - rlStart;
  assert(rlTook >= 1800, `3 polls at 60/min should take ~2s, took ${rlTook}ms`);
  ok(`GEMCATCH_RPM paces a wide sync (3 polls at 60/min took ${rlTook}ms)`);

  // ---- daemon ----
  const dHome = path.join(HOME, 'daemon');
  const dEnv = { GEMCATCH_HOME: dHome };
  const d1 = await submit('SLOW daemon one', [], { env: dEnv });
  const d2 = await submit('SLOW daemon two', [], { env: dEnv });
  const dRun = await cli(['daemon', '-i', '0.05', '--exit-when-idle', '--json'], { env: dEnv });
  const events = dRun.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(events[0].event, 'start', 'daemon should announce itself');
  assert.strictEqual(events[events.length - 1].event, 'stop', 'daemon should exit cleanly when idle');
  const drove = new Set(
    events.filter((e) => e.event === 'update' && e.status === 'completed').map((e) => e.id)
  );
  assert(drove.has(d1) && drove.has(d2), `daemon should drive both to completed: ${dRun.stdout}`);
  ok('daemon polls in-flight tasks to completion and exits when idle');

  // ---- the daemon is what closes the 24h expiry gap ----
  // Nobody polled these by hand, yet both answers are already on disk: `get`
  // must not touch the network. That is the entire point of the daemon.
  const beforeCached = getHits;
  assert.strictEqual((await out(['get', d1], { env: dEnv })).trim(), ANSWER, 'daemon-cached result');
  assert.strictEqual((await out(['get', d2], { env: dEnv })).trim(), ANSWER, 'daemon-cached result');
  assert.strictEqual(getHits, beforeCached, 'the daemon should have cached both before the free tier drops them');
  ok('results the daemon collected survive locally without re-polling');

  // ---- an abrupt kill loses nothing ----
  // Every poll is written to SQLite the moment it lands (better-sqlite3 is
  // synchronous, the store runs in WAL), so a daemon that is killed rather
  // than asked to stop -- SIGKILL, a Windows console close, a power cut --
  // still leaves every result it had already collected on disk. This is what
  // makes the daemon safe to run unattended, so it is worth pinning.
  const kHome = path.join(HOME, 'daemon-kill');
  const kEnv = { GEMCATCH_HOME: kHome };
  const k1 = await submit('SLOW killed daemon', [], { env: kEnv });
  const killed = spawn(process.execPath, [path.join(__dirname, 'index.js'), 'daemon', '-i', '0.05'], {
    env: testEnv(kEnv),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Wait for the daemon to actually finish the task rather than guessing at a
  // sleep, so a slow CI box can't turn this into a flake.
  const kDb = new Database(path.join(kHome, 'tasks.db'), { readonly: true });
  const kDeadline = Date.now() + 20000;
  let kReady = false;
  while (Date.now() < kDeadline) {
    await new Promise((r) => setTimeout(r, 50));
    const row = kDb.prepare('SELECT status FROM tasks WHERE id = ?').get(k1);
    if (row && row.status === 'completed') {
      kReady = true;
      break;
    }
  }
  kDb.close();
  assert(kReady, 'the daemon should have driven the task to completed before we kill it');
  killed.kill('SIGKILL'); // uncatchable: no graceful shutdown gets a chance to help
  await new Promise((r) => killed.on('close', r));
  const beforeKill = getHits;
  assert.strictEqual((await out(['get', k1], { env: kEnv })).trim(), ANSWER, 'result survives an abrupt kill');
  assert.strictEqual(getHits, beforeKill, 'and is served from disk, not re-polled');
  ok('a daemon killed outright still leaves every result it collected on disk');

  // ---- failure path ----
  const bad = await submit('FAIL please');
  const failed = await cli(['get', bad]).catch((e) => e);
  assert.strictEqual(failed.code, 1, 'a failed task should exit non-zero');
  assert(failed.stdout.includes('failed'), `expected failed status: ${failed.stdout}`);
  ok('a failed interaction exits non-zero and says so');

  // ---- cancel ----
  const c = await submit('SLOW cancel me');
  assert((await out(['cancel', c])).includes('cancelled'), 'cancel should report cancelled');
  await assert.rejects(() => cli(['cancel', c]), /already cancelled/, 'double cancel should refuse');
  ok('cancel stops an in-flight task and refuses twice');

  // ---- rm --remote ----
  const r1 = await submit('remove me');
  const iid = new Database(path.join(HOME, 'tasks.db')).prepare('SELECT interaction_id FROM tasks WHERE id = ?').get(r1).interaction_id;
  assert((await out(['rm', r1, '--remote'])).includes('Removed 1 task'), 'rm should confirm');
  assert(!interactions.has(iid), '--remote should delete server-side too');
  assert(!(await out(['list'])).includes(r1), 'removed task should be gone locally');
  ok('rm forgets a task locally and remotely');

  // ---- prune ----
  const dbh = new Database(path.join(HOME, 'tasks.db'));
  dbh.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(Date.now() - 40 * 86400000, id);
  dbh.close();
  const dry = await out(['prune', '--dry-run']);
  assert(dry.includes(id) && dry.includes('would be removed'), `dry-run should list ${id}: ${dry}`);
  assert((await out(['list'])).includes(id), 'dry-run must not delete');
  assert((await out(['prune'])).includes('Pruned 1 task'), 'prune should delete the old one');
  assert(!(await out(['list'])).includes(id), 'pruned task is gone');
  ok('prune drops old finished tasks; --dry-run touches nothing');

  // ---- prune leaves in-flight alone ----
  const keep = await submit('SLOW keep me');
  const dbh2 = new Database(path.join(HOME, 'tasks.db'));
  dbh2.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(1, keep);
  dbh2.close();
  await out(['prune', '-d', '0']);
  assert((await out(['list'])).includes(keep), 'in-flight tasks must survive prune');
  ok('prune never touches in-flight work');

  // ---- stats ----
  const st = JSON.parse(await out(['stats', '--json']));
  assert(st.db.endsWith('tasks.db') && typeof st.total === 'number', `bad stats: ${JSON.stringify(st)}`);
  ok('stats reports the store path and totals');

  // ---- unknown id ----
  await assert.rejects(() => cli(['get', 'nope1234']), /no task matching/, 'unknown id');
  ok('unknown id fails with a pointer to `gemcatch list`');

  // ---- bad key ----
  const keyErr = await cli(['research', 'nope'], { env: { GEMINI_API_KEY: 'WRONG' } }).catch((e) => e);
  assert.strictEqual(keyErr.code, 1, 'bad key exits non-zero');
  assert(/API key not valid/.test(keyErr.stderr), `expected real API message: ${keyErr.stderr}`);
  assert(/aistudio\.google\.com\/apikey/.test(keyErr.stderr), 'should point at the free key page');
  assert.strictEqual(keyRejects, 1, 'a 400 must be surfaced on the first try, not retried four more times');
  ok('a bad key surfaces the real API message and how to fix it, without retrying');

  // ---- missing key ----
  const noKey = await cli(['research', 'nope'], { env: { GEMINI_API_KEY: '', GOOGLE_API_KEY: '' } }).catch((e) => e);
  assert(/GEMINI_API_KEY is not set/.test(noKey.stderr), `expected no-key message: ${noKey.stderr}`);
  ok('a missing key explains how to get one');

  server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nAll offline tests passed.');
})().catch((e) => {
  server.close();
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch (_) {
    /* best effort */
  }
  console.error('\nFAILED:', e.message);
  if (e.stdout) console.error('stdout:', e.stdout);
  if (e.stderr) console.error('stderr:', e.stderr);
  process.exit(1);
});
