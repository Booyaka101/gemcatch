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
        // SLOW stays in_progress for a couple of polls; FAIL/FLAKY/EMPTY and the
        // wedge cases resolve on the first successful one so both paths are
        // reachable in a single `get`.
        pollsLeft: /SLOW/.test(body.input) ? 2 : /FAIL|FLAKY|EMPTY|WATCHWEDGE|HARDFAIL/.test(body.input) ? 0 : 1,
        // FAIL and EMPTY both complete with no text; only FAIL is an error.
        text: /FAIL|EMPTY/.test(body.input) ? '' : ANSWER,
        fails: /FAIL/.test(body.input),
        // FLAKY answers the first two polls with a 503 before behaving.
        flakyLeft: /FLAKY/.test(body.input) ? 2 : 0,
        // WATCHWEDGE 500s a few times then recovers; HARDFAIL 500s forever. Both
        // drive the watch/daemon consecutive-failure safety bound.
        hardFailLeft: /HARDFAIL/.test(body.input) ? Infinity : /WATCHWEDGE/.test(body.input) ? 4 : 0,
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
    // WATCHWEDGE/HARDFAIL: a 500 that, with retries off, surfaces straight to
    // the watch loop and drives its consecutive-failure bound. Infinity never
    // recovers; a finite count recovers once it hits zero.
    if (it.hardFailLeft > 0) {
      it.hardFailLeft -= 1;
      return send(500, { error: { code: 500, message: 'Internal error. Please try again.' } });
    }
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

// Like cli(), but never hangs the suite: if the process doesn't exit within
// `ms` it is killed and the result carries `timedOut: true` for the caller to
// assert on. Used to prove the watch/daemon safety bounds actually fire.
function cliTimeout(args, extra, ms) {
  const o = extra || {};
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'index.js')].concat(args), {
      env: testEnv(o.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, ms);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
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

  // ---- batch: N prompts, one auto tag ----
  const bfile = path.join(HOME, 'batch1.txt');
  fs.writeFileSync(bfile, 'batch alpha\nbatch beta\nbatch gamma\n');
  const bjson = JSON.parse(await out(['batch', bfile, '--json']));
  assert(/^batch-[0-9a-f]{6}$/.test(bjson.tag), `auto tag should be batch-<6hex>: ${bjson.tag}`);
  assert.strictEqual(bjson.submitted.length, 3, 'three prompts, three tasks');
  assert.strictEqual(bjson.failed.length, 0, 'none should fail');
  const bList = JSON.parse(await out(['list', '--json', '--tag', bjson.tag]));
  assert.strictEqual(bList.length, 3, 'all three visible under the one batch tag');
  ok('batch submits N tasks under a single auto-generated tag, collectable via list --tag');

  // ---- batch --json shape ----
  const bshape = JSON.parse(await out(['batch', bfile, '--json', '-t', 'shape-tag']));
  assert.deepStrictEqual(Object.keys(bshape).sort(), ['failed', 'submitted', 'tag'], 'top-level keys');
  assert.deepStrictEqual(
    Object.keys(bshape.submitted[0]).sort(),
    ['id', 'interaction_id', 'prompt', 'status'],
    'each submitted item carries id, interaction_id, status, prompt'
  );
  assert.strictEqual(bshape.submitted[0].status, 'in_progress', 'a fresh submit is in_progress');
  ok('batch --json emits { tag, submitted, failed } with typed submitted items');

  // ---- batch skips blanks and # comments ----
  const cfile = path.join(HOME, 'batch-comments.txt');
  fs.writeFileSync(cfile, '# a comment\nkeep one\n\n   \n# another\nkeep two\n');
  const cj = JSON.parse(await out(['batch', cfile, '--json']));
  assert.deepStrictEqual(cj.submitted.map((s) => s.prompt), ['keep one', 'keep two'], 'only real, trimmed prompts survive');
  ok('batch skips blank lines and # comments');

  // ---- batch --separator keeps multi-line prompts whole ----
  const sfile = path.join(HOME, 'batch-sep.txt');
  fs.writeFileSync(sfile, 'first line A\nsecond line A\n---\nlone prompt B\n');
  const sj = JSON.parse(await out(['batch', sfile, '--json', '--separator', '---']));
  assert.strictEqual(sj.submitted.length, 2, '--separator splits on the delimiter line, not every newline');
  assert(
    sj.submitted[0].prompt.includes('first line A') && sj.submitted[0].prompt.includes('\nsecond line A'),
    `a multi-line prompt must survive intact: ${JSON.stringify(sj.submitted[0].prompt)}`
  );
  ok('batch --separator splits multi-line prompts on a delimiter line');

  // ---- batch -t uses the provided tag ----
  const ct = JSON.parse(await out(['batch', bfile, '--json', '-t', 'mytag']));
  assert.strictEqual(ct.tag, 'mytag', 'a provided tag is used verbatim, no batch- prefix');
  assert.strictEqual(JSON.parse(await out(['list', '--json', '--tag', 'mytag'])).length, 3, 'tasks land under the provided tag');
  ok('batch -t mytag tags every task with the provided tag');

  // ---- batch --dry-run submits nothing ----
  const dfile = path.join(HOME, 'batch-dry.txt');
  fs.writeFileSync(dfile, 'dry one\ndry two\n');
  const dryOut = await out(['batch', dfile, '--dry-run']);
  const dryTag = (dryOut.match(/Batch (\S+):/) || [])[1];
  assert(dryTag, `dry-run should print a tag: ${dryOut}`);
  assert(dryOut.includes('dry one') && dryOut.includes('dry two'), 'dry-run lists the prompts it would submit');
  assert.strictEqual(JSON.parse(await out(['list', '--json', '--tag', dryTag])).length, 0, 'dry-run must create no tasks');
  ok('batch --dry-run lists prompts but submits nothing');

  // ---- batch --watch drives the whole batch to terminal, then tallies ----
  const wfile = path.join(HOME, 'batch-watch.txt');
  fs.writeFileSync(wfile, 'SLOW batch one\nSLOW batch two\n');
  const bw = JSON.parse((await cli(['batch', wfile, '-w', '--json'])).stdout);
  assert.strictEqual(bw.total, 2, 'the summary counts the whole batch');
  assert.strictEqual(bw.completed, 2, `--watch should drive both to completed: ${JSON.stringify(bw)}`);
  assert.strictEqual(bw.failed, 0);
  ok('batch --watch polls the whole batch to completion, then tallies');

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

  // ========================================================================
  // Audit fixes (0.3.0)
  // ========================================================================

  // ---- #1: a poll error mid research --watch never marks a submitted task
  // failed; it stays active and a later poll still completes it. ----
  const wwEnv = { GEMCATCH_HOME: path.join(HOME, 'watchwedge') };
  const ww = await cliTimeout(
    ['research', 'WATCHWEDGE research me', '-w'],
    { env: Object.assign({}, wwEnv, { GEMCATCH_MAX_RETRIES: '0', GEMCATCH_WATCH_MAX_FAILS: '2' }) },
    15000
  );
  assert.strictEqual(ww.timedOut, false, 'the watch must give up, not hang, on a wedged poll');
  assert.strictEqual(ww.code, 1, 'giving up on a watch exits non-zero');
  assert(/[Gg]ave up watching/.test(ww.stderr), `expected a give-up message: ${ww.stderr}`);
  const wwRow = new Database(path.join(wwEnv.GEMCATCH_HOME, 'tasks.db')).prepare('SELECT id, status FROM tasks').get();
  assert.notStrictEqual(wwRow.status, 'failed', 'a watch poll error must never mark the submitted task failed');
  assert.strictEqual(wwRow.status, 'in_progress', `the task stays active for the daemon: ${wwRow.status}`);
  // Full retries (a later get / the daemon) recover it once the blips clear.
  assert.strictEqual((await out(['get', wwRow.id], { env: wwEnv })).trim(), ANSWER, 'a later get still collects the result');
  ok('#1 a poll error during research --watch leaves the task active (not failed); a later get completes it');

  // ---- #2: a 404 on poll retires the task to incomplete, so
  // `daemon --exit-when-idle` converges instead of spinning forever. ----
  const exEnv = { GEMCATCH_HOME: path.join(HOME, 'expire404') };
  const exId = await submit('SLOW expire me', [], { env: exEnv });
  const exIid = new Database(path.join(exEnv.GEMCATCH_HOME, 'tasks.db'))
    .prepare('SELECT interaction_id FROM tasks WHERE id = ?')
    .get(exId).interaction_id;
  interactions.delete(exIid); // the free tier drops it; every poll now 404s
  const exDaemon = await cliTimeout(['daemon', '-i', '0.05', '--exit-when-idle', '--json'], { env: exEnv }, 15000);
  assert.strictEqual(exDaemon.timedOut, false, 'daemon --exit-when-idle must converge once the 404 retires the task');
  const exRow = new Database(path.join(exEnv.GEMCATCH_HOME, 'tasks.db'))
    .prepare('SELECT status, error FROM tasks WHERE id = ?')
    .get(exId);
  assert.strictEqual(exRow.status, 'incomplete', `a 404 poll should retire the task to incomplete: ${JSON.stringify(exRow)}`);
  assert(/not found/.test(exRow.error || ''), 'the retire reason should be recorded');
  ok('#2 a 404 poll retires the task to incomplete and daemon --exit-when-idle converges');

  // ---- #2 (bound): a permanently-failing poll hits the safety bound instead
  // of looping forever. ----
  const hfEnv = { GEMCATCH_HOME: path.join(HOME, 'hardfail') };
  const hfId = await submit('HARDFAIL forever', [], { env: hfEnv });
  const hf = await cliTimeout(
    ['watch', hfId],
    { env: Object.assign({}, hfEnv, { GEMCATCH_MAX_RETRIES: '0', GEMCATCH_WATCH_MAX_FAILS: '3', GEMCATCH_POLL_MS: '20' }) },
    15000
  );
  assert.strictEqual(hf.timedOut, false, 'a persistently failing watch must stop at the bound, not loop forever');
  assert.strictEqual(hf.code, 1, 'hitting the safety bound exits non-zero');
  assert(/consecutive poll failures/.test(hf.stderr), `expected the bound message: ${hf.stderr}`);
  ok('#2 a permanently-failing watch stops at the consecutive-failure bound');

  // ---- #4: prune -d <negative> is rejected and deletes nothing. ----
  const p4Env = { GEMCATCH_HOME: path.join(HOME, 'prune-neg') };
  const p4 = await submit('prune neg victim', [], { env: p4Env });
  await cliTimeout(['watch', p4, '-i', '0.02'], { env: p4Env }, 15000); // drive to completed
  const p4db = new Database(path.join(p4Env.GEMCATCH_HOME, 'tasks.db'));
  p4db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(Date.now() - 999 * 86400000, p4);
  p4db.close();
  const p4rej = await cli(['prune', '-d', '-5'], { env: p4Env }).catch((e) => e);
  assert.strictEqual(p4rej.code, 1, 'prune -d -5 should be rejected');
  assert(/--days must be a non-negative number/.test(p4rej.stderr), `expected a clear rejection: ${p4rej.stderr}`);
  assert((await out(['list'], { env: p4Env })).includes(p4), 'a rejected prune must delete nothing, even an ancient finished task');
  ok('#4 prune -d <negative> is rejected and deletes nothing');

  // ---- #5: a completed-but-empty result is served from cache, not re-polled. ----
  const emEnv = { GEMCATCH_HOME: path.join(HOME, 'empty') };
  const emId = await submit('EMPTY result please', [], { env: emEnv });
  const em1 = await cliTimeout(['watch', emId, '-i', '0.02'], { env: emEnv }, 15000);
  assert.strictEqual(em1.code, 0, `an empty completion is still a success: ${em1.stderr}`);
  const beforeEmpty = getHits;
  const em2 = await cli(['get', emId], { env: emEnv });
  assert.strictEqual(getHits, beforeEmpty, 'an empty completed result must come from SQLite, not the API');
  assert(/empty response/.test(em2.stdout), `an empty result reads as (empty response): ${JSON.stringify(em2.stdout)}`);
  ok('#5 a completed-but-empty result is served from cache without re-polling');

  // ---- #6: `#` is a comment only with trailing whitespace; "#1 ..." survives,
  // and the skipped count is reported on stderr. ----
  const c6 = path.join(HOME, 'batch-hash.txt');
  fs.writeFileSync(c6, '# a comment\n#1 cause of failures?\nkeep two\n\n# another comment\n');
  const r6 = await cli(['batch', c6, '--json']);
  const j6 = JSON.parse(r6.stdout);
  assert.deepStrictEqual(
    j6.submitted.map((s) => s.prompt),
    ['#1 cause of failures?', 'keep two'],
    'a "#1 ..." line is a prompt, not a comment; "# ..." lines are skipped'
  );
  assert(/skipped 3 blank\/comment lines/.test(r6.stderr), `the skipped count should be noted on stderr: ${r6.stderr}`);
  ok('#6 batch keeps "#1 ..." prompts, skips "# ..." comments, and reports the count');

  // ---- #7: list -n 0 returns zero rows (not all); watch -i <=0 is rejected. ----
  assert.strictEqual(JSON.parse(await out(['list', '--json', '-n', '0'])).length, 0, '-n 0 caps to zero rows, not all');
  const i7Env = { GEMCATCH_HOME: path.join(HOME, 'interval') };
  const i7 = await submit('SLOW interval victim', [], { env: i7Env });
  const ivRej = await cli(['watch', i7, '-i', '-5'], { env: i7Env }).catch((e) => e);
  assert.strictEqual(ivRej.code, 1, 'watch -i -5 should be rejected');
  assert(/--interval must be a positive number/.test(ivRej.stderr), `expected interval validation: ${ivRej.stderr}`);
  ok('#7 list -n 0 returns zero rows; watch -i <=0 is rejected');

  // ---- #8: export gathers a tag's completed prompts + results (md/json/-o). ----
  const xpEnv = { GEMCATCH_HOME: path.join(HOME, 'export') };
  const xp1 = await submit('first export question', ['-t', 'expt'], { env: xpEnv });
  const xp2 = await submit('second export question', ['-t', 'expt'], { env: xpEnv });
  await cliTimeout(['watch', xp1, '-i', '0.02'], { env: xpEnv }, 15000);
  await cliTimeout(['watch', xp2, '-i', '0.02'], { env: xpEnv }, 15000);
  const md = await out(['export', '--tag', 'expt', '--format', 'md'], { env: xpEnv });
  assert(md.includes('## first export question') && md.includes('## second export question'), `each prompt should be a heading: ${md}`);
  const answerHits = (md.match(new RegExp(ANSWER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  assert.strictEqual(answerHits, 2, 'both completed results should appear in the export');
  assert(md.includes(xp1) && md.includes(xp2), 'each section carries its task id');
  assert(md.indexOf('first export question') < md.indexOf('second export question'), 'export reads oldest-first');
  const jx = JSON.parse(await out(['export', '--tag', 'expt', '--format', 'json'], { env: xpEnv }));
  assert.strictEqual(jx.length, 2, 'json export has one object per result');
  assert.strictEqual(jx[0].result, ANSWER, 'json export carries the result text');
  const xpFile = path.join(xpEnv.GEMCATCH_HOME, 'out.md');
  const xpo = await cli(['export', '--tag', 'expt', '-o', xpFile], { env: xpEnv });
  assert(fs.existsSync(xpFile) && fs.readFileSync(xpFile, 'utf8').includes(ANSWER), '-o writes the export to a file');
  assert(/Wrote 2 result/.test(xpo.stderr), 'the -o confirmation goes to stderr, not the file');
  ok('#8 export gathers a tag\'s completed prompts + results as md/json and to a file');

  // ---- digest: synthesize a tag's completed results through one Gemini call. ----
  const dg = await cliTimeout(['digest', '--tag', 'expt'], { env: xpEnv }, 15000);
  assert.strictEqual(dg.code, 0, `digest should succeed: ${dg.stderr}`);
  assert.strictEqual(dg.stdout.trim(), ANSWER, 'digest prints the synthesized result on stdout');
  assert(/Digesting 2 result/.test(dg.stderr), 'digest reports what it is summarizing on stderr');
  assert.strictEqual(
    JSON.parse(await out(['list', '--json', '--tag', 'expt-digest'], { env: xpEnv })).length,
    1,
    'the digest lands under <tag>-digest, not the source tag'
  );
  ok('digest feeds a tag\'s completed results through one Gemini call into a single summary');

  // ---- #3: the default SDK transport, exercised against a stubbed @google/genai.
  // Every test above forces GEMCATCH_FORCE_REST=1, so sdkInteractions() is
  // otherwise never covered. Inject a stub client and drive it directly. ----
  {
    const genaiPath = require.resolve('@google/genai');
    const geminiPath = require.resolve('./gemini');
    const sdkState = new Map();
    let sdkSeq = 0;
    class StubGenAI {
      constructor(cfg) {
        assert(cfg && cfg.apiKey, 'the SDK client must be built with an apiKey');
        this.interactions = {
          create: async (body) => {
            assert.strictEqual(body.background, true, 'SDK submit must pass background:true');
            assert.strictEqual(typeof body.input, 'string', 'SDK input must be a plain string');
            const id = `sdk_${++sdkSeq}`;
            sdkState.set(id, { polls: /SLOW/.test(body.input) ? 1 : 0, boom: /BOOM/.test(body.input) });
            return { id, status: 'in_progress' };
          },
          get: async (id) => {
            const s = sdkState.get(id);
            if (s.boom) {
              // Mimic the SDK's real failure shape: a useless stub .message plus
              // Google's true payload as a JSON string on .body -- exactly what
              // friendly() unwraps into a readable error.
              const e = new Error('400 API error occurred: {"httpMeta":{}}');
              e.status = 400;
              e.body = JSON.stringify({ error: { code: 400, message: 'Unknown model id via SDK.' } });
              throw e;
            }
            if (s.polls > 0) {
              s.polls -= 1;
              return { id, status: 'in_progress' };
            }
            // The SDK synthesises output_text; return one so shape() prefers it.
            return { id, status: 'completed', output_text: ANSWER, usage: { total_tokens: 7 } };
          },
        };
      }
    }
    const saved = {
      key: process.env.GEMINI_API_KEY,
      force: process.env.GEMCATCH_FORCE_REST,
      rpm: process.env.GEMCATCH_RPM,
    };
    process.env.GEMINI_API_KEY = 'TEST_KEY';
    delete process.env.GEMCATCH_FORCE_REST; // let the SDK path win over the fallback
    process.env.GEMCATCH_RPM = '0'; // no pacing for these in-process calls
    require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: { GoogleGenAI: StubGenAI } };
    delete require.cache[geminiPath]; // reload so sdkInteractions() memoizes the stub
    const sdk = require('./gemini');

    const s = await sdk.submit('SLOW via the sdk', { model: 'gemini-3.1-flash' });
    assert.strictEqual(s.status, 'in_progress', 'SDK submit returns in_progress');
    assert(/^sdk_/.test(s.interactionId), `shape() must read id off the SDK response: ${s.interactionId}`);
    let p = await sdk.poll(s.interactionId);
    assert.strictEqual(p.status, 'in_progress', 'first SDK poll is still running');
    p = await sdk.poll(s.interactionId);
    assert.strictEqual(p.status, 'completed', 'second SDK poll completes');
    assert.strictEqual(p.text, ANSWER, 'shape() prefers the SDK-synthesised output_text');
    assert.strictEqual(p.usage.total_tokens, 7, 'shape() carries usage through the SDK path');

    const boom = await sdk.submit('BOOM').then((r) => sdk.poll(r.interactionId)).catch((e) => e);
    assert(/Unknown model id via SDK/.test(boom.message), `friendly() must surface the SDK's real payload: ${boom.message}`);
    assert.strictEqual(boom.httpStatus, 400, 'friendly() maps the SDK error to its HTTP status');

    // Restore: nothing after this should see the stub or the fake key.
    delete require.cache[geminiPath];
    delete require.cache[genaiPath];
    if (saved.key === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.key;
    if (saved.force === undefined) delete process.env.GEMCATCH_FORCE_REST;
    else process.env.GEMCATCH_FORCE_REST = saved.force;
    if (saved.rpm === undefined) delete process.env.GEMCATCH_RPM;
    else process.env.GEMCATCH_RPM = saved.rpm;
    ok('#3 SDK transport: submit -> poll -> completed and a friendly() error, via a stubbed @google/genai');
  }

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
