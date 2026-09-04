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
// An agent's report lives in the FINAL step; the interim steps hold the plan
// and drafts and must never leak into the result.
const AGENT_ANSWER =
  'Deep Research report: the EU AI Act phases in high-risk obligations from August 2026, ' +
  'while the UK relies on regulator-led guidance.';
const AGENT_CITATIONS = [
  { title: 'EU AI Act — EUR-Lex', url: 'https://eur-lex.europa.eu/eli/reg/2024/1689' },
  { title: 'UK AI regulation white paper', url: 'https://www.gov.uk/ai-regulation-pro-innovation' },
];
// What a collaborative-planning turn comes back with: a plan, not a report.
const PLAN_TEXT =
  'Research plan:\n1. Map the EU AI Act high-risk articles and their dates.\n' +
  '2. Map the UK regulator-led approach.\n3. Compare obligation by obligation.';
// The mock accepts exactly the documented preview ids; anything else 4xxes,
// like the real API would for a bad agent id.
const KNOWN_AGENTS = new Set(['deep-research-preview-04-2026', 'deep-research-max-preview-04-2026']);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcatch-test-'));

let seq = 0;
let getHits = 0;
let keyRejects = 0;
let flaky503s = 0;
let agentRejects = 0;
let prevRejects = 0;
const interactions = new Map(); // id -> {status, pollsLeft, text, model, system, agent, deleted}

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
      // `agent` replaces `model` on create; the two are mutually exclusive and
      // exactly one must be present. The CLI enforces this before submitting,
      // so the mock asserting it catches any regression that slips one through.
      assert(!(body.agent && body.model), 'agent and model are mutually exclusive');
      assert(body.agent || body.model, 'one of agent or model is required');
      if (body.agent && !KNOWN_AGENTS.has(body.agent)) {
        agentRejects += 1;
        return send(400, { error: { code: 400, message: `Unknown agent id: ${body.agent}.` } });
      }
      // Collaborative planning is an agent_config field, not a top-level one,
      // and the docs send the whole block with it. An ordinary run sends no
      // agent_config at all, which is why its absence is not an error.
      const cfg = body.agent_config;
      if (cfg !== undefined) {
        assert(body.agent, 'agent_config only applies to an agent run');
        assert.strictEqual(cfg.type, 'deep-research', 'agent_config.type per the docs');
        assert.strictEqual(cfg.thinking_summaries, 'auto', 'agent_config.thinking_summaries per the docs');
        assert.strictEqual(typeof cfg.collaborative_planning, 'boolean', 'collaborative_planning is a boolean');
      }
      // A continuation names the interaction it follows. One the server can no
      // longer resolve -- dropped after the retention window -- is a 404, which
      // is exactly what an approve of an expired plan must not walk into.
      if (body.previous_interaction_id !== undefined) {
        assert(body.agent, 'a continuation is an agent run');
        if (!interactions.has(body.previous_interaction_id)) {
          prevRejects += 1;
          return send(404, {
            error: { code: 404, message: `Interaction ${body.previous_interaction_id} not found.` },
          });
        }
      }
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
        agent: body.agent,
        planning: !!(cfg && cfg.collaborative_planning),
        previousInteractionId: body.previous_interaction_id,
        // BUDGETPAUSE mimics a max_total_tokens cap being hit: the agent run
        // "safely pauses" and the interaction comes back status: incomplete.
        budgetPause: /BUDGETPAUSE/.test(body.input),
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
    if (it.agent) {
      // A max_total_tokens budget pause: the run stops part-way and the
      // interaction returns status incomplete -- terminal, with no report.
      if (it.budgetPause) {
        return send(200, {
          id: idPart,
          agent: it.agent,
          status: 'incomplete',
          usage: { total_tokens: 500 },
          steps: [
            { type: 'user_input', content: [{ type: 'text', text: it.prompt }] },
            { type: 'thought', signature: 'redacted' },
          ],
        });
      }
      // A collaborative-planning turn returns the PLAN instead of a report --
      // same step shape, no citations, nothing researched yet. A refine echoes
      // its instruction so the chain can be proven to have reached the server.
      if (it.planning) {
        const revised = it.previousInteractionId ? `\n(revised: ${it.prompt})` : '';
        return send(200, {
          id: idPart,
          agent: it.agent,
          status: 'completed',
          previous_interaction_id: it.previousInteractionId,
          usage: { total_tokens: 120 },
          steps: [
            { type: 'user_input', content: [{ type: 'text', text: it.prompt }] },
            { type: 'thought', signature: 'redacted' },
            { type: 'model_output', content: [{ type: 'text', text: PLAN_TEXT + revised }] },
          ],
        });
      }
      // An agent run is multi-step: plan and interim drafts first, the actual
      // report in the FINAL step (docs: interaction.steps[-1].content[0].text),
      // with citations attached. Only that final step's text is the answer.
      return send(200, {
        id: idPart,
        agent: it.agent,
        status: 'completed',
        previous_interaction_id: it.previousInteractionId,
        usage: { total_tokens: 1234 },
        steps: [
          { type: 'user_input', content: [{ type: 'text', text: it.prompt }] },
          { type: 'thought', signature: 'redacted' },
          { type: 'model_output', content: [{ type: 'text', text: 'Interim: research plan drafted, 12 sources fetched.' }] },
          { type: 'model_output', content: [{ type: 'text', text: AGENT_ANSWER }], citations: AGENT_CITATIONS },
        ],
      });
    }
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

// Open-query-close helpers: on Windows a leaked better-sqlite3 handle keeps
// tasks.db locked and the suite's final rmSync dies with EBUSY.
function qget(home, sql, ...params) {
  const d = new Database(path.join(home, 'tasks.db'), { readonly: true });
  try {
    return d.prepare(sql).get(...params);
  } finally {
    d.close();
  }
}
function qall(home, sql, ...params) {
  const d = new Database(path.join(home, 'tasks.db'), { readonly: true });
  try {
    return d.prepare(sql).all(...params);
  } finally {
    d.close();
  }
}
// Row count that treats "no db yet" as zero -- a refused submission may exit
// before the store is even created, and both outcomes are "nothing written".
function taskCount(home) {
  if (!fs.existsSync(path.join(home, 'tasks.db'))) return 0;
  return qget(home, 'SELECT COUNT(*) AS n FROM tasks').n;
}
const idOf = (text) => (text.match(/^Task (\w+) submitted\./m) || [])[1];
const planIdOf = (text) => (text.match(/^Plan task (\w+) submitted/m) || [])[1];
const approveIdOf = (text) => (text.match(/^Task (\w+) submitted \(approves/m) || [])[1];
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

  // Agent runs: the report is the FINAL answer-bearing step; the interim
  // drafts must not be concatenated in, and citations are metadata, never text.
  const agentShaped = {
    agent: 'deep-research-preview-04-2026',
    steps: [
      { type: 'user_input', content: [{ type: 'text', text: 'the prompt' }] },
      { type: 'thought', signature: 'redacted' },
      { type: 'model_output', content: [{ type: 'text', text: 'interim draft' }] },
      {
        type: 'model_output',
        content: [{ type: 'text', text: 'the final report' }],
        citations: [{ title: 'A Source', url: 'https://example.com/a' }],
      },
    ],
  };
  assert.strictEqual(gemini.textOf(agentShaped), 'the final report');
  assert.deepStrictEqual(gemini.citationsOf(agentShaped), [{ title: 'A Source', url: 'https://example.com/a' }]);
  assert.strictEqual(gemini.citationsOf({ steps: [] }), null, 'a model run has no citations');
  ok('textOf takes the final step of an agent run; citationsOf gathers sources, textOf excludes them');

  // ONE alias table: known aliases resolve to the full preview ids, anything
  // else passes through untouched so future agent ids need no gemcatch release.
  assert.strictEqual(gemini.resolveAgent('deep-research'), 'deep-research-preview-04-2026');
  assert.strictEqual(gemini.resolveAgent('deep-research-max'), 'deep-research-max-preview-04-2026');
  assert.strictEqual(gemini.resolveAgent('some-future-agent-01-2027'), 'some-future-agent-01-2027');
  assert(gemini.AGENT_PRICE_BANDS['deep-research-preview-04-2026'], 'the standard band exists');
  assert(gemini.AGENT_PRICE_BANDS['deep-research-max-preview-04-2026'], 'the max band exists');
  ok('resolveAgent maps aliases through one table and passes unknown ids through');

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
  for (const c of ['model', 'tag', 'usage', 'updated_at', 'error', 'system_instruction', 'agent', 'citations']) {
    assert(cols.includes(c), `migration should add ${c}`);
  }
  ok('a v1 tasks.db migrates in place without losing rows');

  // ---- v0.3.0 -> 0.4.0 migration ----
  // A store written by 0.3.0 (all pre-agent columns, no agent/citations) must
  // upgrade in place: every row preserved, agent reported as NULL for them.
  const v030 = path.join(HOME, 'v030');
  fs.mkdirSync(v030, { recursive: true });
  const v030Db = new Database(path.join(v030, 'tasks.db'));
  v030Db.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT, interaction_id TEXT, status TEXT DEFAULT 'pending', " +
      'result TEXT, created_at INTEGER, model TEXT, system_instruction TEXT, tag TEXT, error TEXT, usage TEXT, updated_at INTEGER)'
  );
  const insV030 = v030Db.prepare(
    'INSERT INTO tasks (id, prompt, status, result, created_at, model) VALUES (?,?,?,?,?,?)'
  );
  insV030.run('pre04001', 'a 0.3.0 row', 'completed', 'old answer', 100, 'gemini-3.1-flash-lite');
  insV030.run('pre04002', 'another 0.3.0 row', 'in_progress', null, 200, 'gemini-3.1-flash-lite');
  v030Db.close();
  const v030Rows = JSON.parse(await out(['list', '--json'], { env: { GEMCATCH_HOME: v030 } }));
  assert.strictEqual(v030Rows.length, 2, 'every 0.3.0 row survives the 0.4.0 migration');
  for (const r of v030Rows) assert.strictEqual(r.agent, null, `a pre-agent row reports agent as NULL: ${JSON.stringify(r)}`);
  assert.strictEqual(v030Rows.find((r) => r.id === 'pre04001').result, 'old answer', 'results are untouched');
  ok('a v0.3.0 tasks.db migrates to 0.4.0 preserving every row, agent NULL for all of them');

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
  assert.strictEqual(interactions.get(dflt.interaction_id).model, 'gemini-3.5-flash-lite', 'default model');
  ok('default model is gemini-3.5-flash-lite (GA since 2026-07-21)');

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

  // ========================================================================
  // Research agents (0.4.0)
  // ========================================================================

  // ---- research --agent: alias resolves, agent (not model) reaches the API,
  // the row records the full preview id, and the report comes from the final
  // step with its citations persisted. ----
  const agEnv = { GEMCATCH_HOME: path.join(HOME, 'agent') };
  const agRun = await cli(['research', 'map the EU AI Act against the UK approach', '--agent', 'deep-research', '--yes'], { env: agEnv });
  const agId = idOf(agRun.stdout);
  assert(agId, `agent research should submit: ${agRun.stdout}`);
  assert(
    /Agent deep-research-preview-04-2026 — estimated \$1\.00–\$3\.00 for this task \(preview rates, subject to change\)\./.test(agRun.stderr),
    `the spend band must be shown even under --yes: ${agRun.stderr}`
  );
  const agRow = qget(agEnv.GEMCATCH_HOME, 'SELECT agent, model, interaction_id FROM tasks WHERE id = ?', agId);
  assert.strictEqual(agRow.agent, 'deep-research-preview-04-2026', 'the row stores the RESOLVED agent id');
  assert.strictEqual(agRow.model, null, 'an agent run stores no model');
  assert.strictEqual(interactions.get(agRow.interaction_id).agent, 'deep-research-preview-04-2026', 'the API got `agent`');
  assert.strictEqual(interactions.get(agRow.interaction_id).model, undefined, 'the API must NOT get `model`');
  await out(['get', agId], { env: agEnv }); // first poll: still in_progress
  const agGet = await out(['get', agId], { env: agEnv });
  assert(agGet.includes(AGENT_ANSWER), `get should print the final-step report: ${agGet}`);
  assert(!agGet.includes('Interim'), 'interim agent steps must not leak into the result');
  assert(agGet.includes('Sources:'), 'an agent result lists its sources');
  for (const c of AGENT_CITATIONS) assert(agGet.includes(c.url), `each citation url is printed: ${c.url}`);
  const agCits = qget(agEnv.GEMCATCH_HOME, 'SELECT citations FROM tasks WHERE id = ?', agId);
  assert.deepStrictEqual(JSON.parse(agCits.citations), AGENT_CITATIONS, 'citations are persisted as JSON');
  const agJson = JSON.parse(await out(['get', agId, '--json'], { env: agEnv }));
  assert.deepStrictEqual(agJson.citations, AGENT_CITATIONS, 'get --json carries the citations from cache');
  ok('research --agent resolves the alias, sends agent instead of model, takes the final step, keeps citations');

  // ---- list shows the agent; stats counts agent runs ----
  const agList = await out(['list'], { env: agEnv });
  assert(/AGENT/.test(agList), `list grows an AGENT column when an agent run exists: ${agList}`);
  assert(/deep-research/.test(agList), 'the agent is shown against its task');
  const agStats = JSON.parse(await out(['stats', '--json'], { env: agEnv }));
  assert.deepStrictEqual(agStats.by_agent, [{ agent: 'deep-research-preview-04-2026', n: 1 }], 'stats counts per agent');
  const agStatsHuman = await out(['stats'], { env: agEnv });
  assert(/Agent runs:/.test(agStatsHuman) && /deep-research-preview-04-2026/.test(agStatsHuman), `stats names the agent: ${agStatsHuman}`);
  ok('list shows an AGENT column and stats tallies agent runs');

  // ---- --model and --agent together: clean error, nothing submitted ----
  const mxEnv = { GEMCATCH_HOME: path.join(HOME, 'mutex') };
  const mx = await cli(['research', 'x', '--agent', 'deep-research', '--model', 'gemini-3.6-flash', '--yes'], { env: mxEnv }).catch((e) => e);
  assert.strictEqual(mx.code, 1, '--model + --agent must be rejected');
  assert(/--model and --agent are mutually exclusive/.test(mx.stderr), `expected the mutual-exclusion message: ${mx.stderr}`);
  const mxB = await cli(['batch', '-', '--agent', 'deep-research', '--model', 'gemini-3.6-flash', '--yes'], { env: mxEnv, stdin: 'q one\n' }).catch((e) => e);
  assert.strictEqual(mxB.code, 1, 'batch rejects the combination too');
  assert(/mutually exclusive/.test(mxB.stderr), `batch should explain: ${mxB.stderr}`);
  assert.strictEqual(taskCount(mxEnv.GEMCATCH_HOME), 0, 'a rejected flag combination writes no rows');
  ok('--model with --agent is a clean error and nothing is submitted');

  // ---- unknown raw agent id: passed through, the 4xx surfaces immediately ----
  const unEnv = { GEMCATCH_HOME: path.join(HOME, 'unknown-agent') };
  const beforeAgentRejects = agentRejects;
  const un = await cli(['research', 'probe', '--agent', 'brand-new-agent-01-2027', '--yes'], { env: unEnv }).catch((e) => e);
  assert.strictEqual(un.code, 1, 'an unknown agent id fails');
  assert(/Unknown agent id: brand-new-agent-01-2027/.test(un.stderr), `the API's own 4xx message surfaces: ${un.stderr}`);
  assert(/no published price band/.test(un.stderr), 'the guard is honest when it has no band for an id');
  assert.strictEqual(agentRejects - beforeAgentRejects, 1, 'a 4xx on submit is not retried');
  const unRow = qget(unEnv.GEMCATCH_HOME, 'SELECT status FROM tasks');
  assert.strictEqual(unRow.status, 'failed', 'the failed submit is recorded');
  ok('an unknown raw agent id passes through and the API 4xx surfaces immediately, unretried');

  // ---- spend guard: declined -> zero rows, non-zero exit ----
  const dcEnv = { GEMCATCH_HOME: path.join(HOME, 'declined') };
  const dc = await cli(['research', 'expensive question', '--agent', 'deep-research-max'],
    { env: Object.assign({}, dcEnv, { GEMCATCH_ASSUME_TTY: '1' }), stdin: 'n\n' }).catch((e) => e);
  assert.strictEqual(dc.code, 1, 'declining the confirmation exits non-zero');
  assert(/\$3\.00–\$7\.00/.test(dc.stderr), `the max band is quoted before asking: ${dc.stderr}`);
  assert(/Nothing submitted/.test(dc.stderr), `declining says so: ${dc.stderr}`);
  assert.strictEqual(taskCount(dcEnv.GEMCATCH_HOME), 0, 'declining must leave the tasks table untouched');
  ok('declining the confirmation writes zero rows and exits non-zero');

  // ---- spend guard: an interactive "y" submits ----
  const ycEnv = { GEMCATCH_HOME: path.join(HOME, 'confirmed') };
  const yc = await cli(['research', 'go ahead', '--agent', 'deep-research'],
    { env: Object.assign({}, ycEnv, { GEMCATCH_ASSUME_TTY: '1' }), stdin: 'y\n' });
  assert(idOf(yc.stdout), `answering y submits: ${yc.stdout}`);
  assert(/Submit\? \[y\/N\]/.test(yc.stderr), `the y/N question is asked on stderr: ${yc.stderr}`);
  ok('answering y to the confirmation submits the task');

  // ---- spend guard: non-TTY without --yes is refused ----
  const ntEnv = { GEMCATCH_HOME: path.join(HOME, 'notty') };
  const nt = await cli(['research', 'scripted', '--agent', 'deep-research'], { env: ntEnv }).catch((e) => e);
  assert.strictEqual(nt.code, 1, 'non-TTY without --yes must refuse');
  assert(/stdin is not a TTY/.test(nt.stderr) && /--yes/.test(nt.stderr), `the refusal names the fix: ${nt.stderr}`);
  assert.strictEqual(taskCount(ntEnv.GEMCATCH_HOME), 0, 'a refused submission writes no rows');
  ok('non-TTY without --yes is refused before anything is written');

  // ---- research --agent --dry-run: band printed, nothing submitted ----
  const rdEnv = { GEMCATCH_HOME: path.join(HOME, 'research-dry') };
  const rd = await out(['research', 'preview only', '--agent', 'deep-research', '--dry-run'], { env: rdEnv });
  assert(
    /Agent deep-research-preview-04-2026 — estimated \$1\.00–\$3\.00 for this task\. Nothing submitted \(--dry-run\)\./.test(rd),
    `dry-run prints the projected spend: ${rd}`
  );
  assert.strictEqual(taskCount(rdEnv.GEMCATCH_HOME), 0, 'research --dry-run submits nothing');
  ok('research --agent --dry-run prints the band and submits nothing');

  // ---- batch --agent --dry-run: N × band total, nothing submitted ----
  const bdEnv = { GEMCATCH_HOME: path.join(HOME, 'batch-dry-agent') };
  const bdFile = path.join(HOME, 'agent-batch.txt');
  fs.writeFileSync(bdFile, 'q one\nq two\nq three\n');
  const bd = await out(['batch', bdFile, '--agent', 'deep-research-max', '--dry-run'], { env: bdEnv });
  assert(
    /3 prompts × deep-research-max-preview-04-2026 — estimated \$9\.00–\$21\.00 total\. Nothing submitted \(--dry-run\)\./.test(bd),
    `batch dry-run multiplies the band by N: ${bd}`
  );
  assert.strictEqual(taskCount(bdEnv.GEMCATCH_HOME), 0, 'batch --dry-run submits nothing');
  ok('batch --agent --dry-run prints the N × band total and submits nothing');

  // ---- batch --agent --yes: every row carries the resolved agent ----
  const baEnv = { GEMCATCH_HOME: path.join(HOME, 'batch-agent') };
  const ba = await cli(['batch', bdFile, '--agent', 'deep-research', '--yes', '--json', '-t', 'agents'], { env: baEnv });
  assert(/3 prompts × deep-research-preview-04-2026 — estimated \$3\.00–\$9\.00 total/.test(ba.stderr),
    `the batch guard quotes N × band on stderr: ${ba.stderr}`);
  const baJson = JSON.parse(ba.stdout);
  assert.strictEqual(baJson.submitted.length, 3, 'all three submitted');
  const baRows = qall(baEnv.GEMCATCH_HOME, 'SELECT agent, model FROM tasks');
  for (const r of baRows) {
    assert.strictEqual(r.agent, 'deep-research-preview-04-2026', 'each batch row stores the resolved agent');
    assert.strictEqual(r.model, null, 'no model on agent rows');
  }
  ok('batch --agent --yes submits the file with the resolved agent on every row');

  // ---- an agent run that hits its budget: status incomplete is terminal, the
  // daemon retires it and converges instead of spinning. ----
  const bpEnv = { GEMCATCH_HOME: path.join(HOME, 'budget-pause') };
  const bpRun = await cli(['research', 'BUDGETPAUSE giant question', '--agent', 'deep-research', '--yes'], { env: bpEnv });
  const bpId = idOf(bpRun.stdout);
  const bpDaemon = await cliTimeout(['daemon', '-i', '0.05', '--exit-when-idle', '--json'], { env: bpEnv }, 15000);
  assert.strictEqual(bpDaemon.timedOut, false, 'the daemon must converge on an incomplete agent run, not spin');
  const bpRow = qget(bpEnv.GEMCATCH_HOME, 'SELECT status FROM tasks WHERE id = ?', bpId);
  assert.strictEqual(bpRow.status, 'incomplete', `a budget pause retires the task as incomplete: ${JSON.stringify(bpRow)}`);
  ok('an agent run paused by its token budget (status incomplete) retires cleanly; the daemon converges');

  // ---- an agent interaction 404ing after the free tier's 1-day retention
  // takes the existing retire-to-incomplete path unchanged. ----
  const axEnv = { GEMCATCH_HOME: path.join(HOME, 'agent-expire') };
  const axRun = await cli(['research', 'SLOW agent expiry', '--agent', 'deep-research', '--yes'], { env: axEnv });
  const axId = idOf(axRun.stdout);
  const axIid = qget(axEnv.GEMCATCH_HOME, 'SELECT interaction_id FROM tasks WHERE id = ?', axId).interaction_id;
  interactions.delete(axIid);
  const axDaemon = await cliTimeout(['daemon', '-i', '0.05', '--exit-when-idle', '--json'], { env: axEnv }, 15000);
  assert.strictEqual(axDaemon.timedOut, false, 'the daemon converges once the 404 retires the agent task');
  const axRow = qget(axEnv.GEMCATCH_HOME, 'SELECT status FROM tasks WHERE id = ?', axId);
  assert.strictEqual(axRow.status, 'incomplete', 'an expired agent interaction retires to incomplete');
  ok('an expired (404) agent interaction retires to incomplete exactly like a model one');

  // ========================================================================
  // Collaborative planning (0.5.0)
  // ========================================================================

  // ---- v0.4.0 -> 0.5.0 migration ----
  // A store written by 0.4.0 (agent + citations, no plan-chain columns) must
  // upgrade in place and then behave exactly as it did: every row preserved,
  // kind backfilled to 'task' by the column default, the chain columns NULL,
  // no KIND column in `list`, and a cached result still served from disk.
  const v040 = path.join(HOME, 'v040');
  fs.mkdirSync(v040, { recursive: true });
  const v040Db = new Database(path.join(v040, 'tasks.db'));
  v040Db.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT, interaction_id TEXT, status TEXT DEFAULT 'pending', " +
      'result TEXT, created_at INTEGER, model TEXT, system_instruction TEXT, tag TEXT, error TEXT, usage TEXT, ' +
      'updated_at INTEGER, agent TEXT, citations TEXT)'
  );
  const insV040 = v040Db.prepare(
    'INSERT INTO tasks (id, prompt, status, result, created_at, model, agent, citations) VALUES (?,?,?,?,?,?,?,?)'
  );
  insV040.run('pre05001', 'a 0.4.0 model row', 'completed', 'old answer', 100, 'gemini-3.5-flash-lite', null, null);
  insV040.run(
    'pre05002',
    'a 0.4.0 agent row',
    'completed',
    'old report',
    200,
    null,
    'deep-research-preview-04-2026',
    JSON.stringify(AGENT_CITATIONS)
  );
  v040Db.close();
  const v040Rows = JSON.parse(await out(['list', '--json'], { env: { GEMCATCH_HOME: v040 } }));
  assert.strictEqual(v040Rows.length, 2, 'every 0.4.0 row survives the 0.5.0 migration');
  for (const r of v040Rows) {
    assert.strictEqual(r.kind, 'task', 'a pre-plan row reads back as kind task');
    assert.strictEqual(r.parent_id, null, 'a pre-plan row has no parent');
    assert.strictEqual(r.collaborative_planning, null, 'a pre-plan row sent no agent_config');
    assert.strictEqual(r.previous_interaction_id, null, 'a pre-plan row continues nothing');
  }
  assert.strictEqual(v040Rows.find((r) => r.id === 'pre05001').result, 'old answer', 'results are untouched');
  const v040List = await out(['list'], { env: { GEMCATCH_HOME: v040 } });
  assert(!/KIND/.test(v040List), `a store with no plans keeps the layout it had: ${v040List}`);
  assert(/AGENT/.test(v040List), 'the 0.4.0 AGENT column still appears');
  const v040Get = await cli(['get', 'pre05001'], { env: { GEMCATCH_HOME: v040 } });
  assert.strictEqual(v040Get.stdout.trim(), 'old answer', 'a 0.4.0 cached result still reads back');
  assert.strictEqual(v040Get.stderr, '', 'and prints no plan chatter');
  ok('a v0.4.0 tasks.db migrates to 0.5.0 preserving every row and behaving exactly as before');

  // ---- --plan with --model (or with no agent at all) is rejected ----
  const pmEnv = { GEMCATCH_HOME: path.join(HOME, 'plan-model') };
  const pm = await cli(['research', 'x', '--plan', '--model', 'gemini-3.5-flash-lite'], { env: pmEnv }).catch((e) => e);
  assert.strictEqual(pm.code, 1, '--plan with --model must be rejected');
  assert(/--plan is a research-agent feature/.test(pm.stderr), `expected the agent-only message: ${pm.stderr}`);
  const pmBare = await cli(['research', 'x', '--plan'], { env: pmEnv }).catch((e) => e);
  assert.strictEqual(pmBare.code, 1, '--plan with no agent is the same mistake');
  assert(/--plan is a research-agent feature/.test(pmBare.stderr), `bare --plan should explain: ${pmBare.stderr}`);
  const pmBatch = await cli(['batch', '-', '--plan', '--model', 'gemini-3.5-flash-lite'], { env: pmEnv, stdin: 'q\n' }).catch((e) => e);
  assert.strictEqual(pmBatch.code, 1, 'batch rejects it too');
  assert.strictEqual(taskCount(pmEnv.GEMCATCH_HOME), 0, 'a rejected flag combination writes no rows');
  ok('--plan without --agent (or with --model) is a clean error and nothing is submitted');

  // ---- research --agent --plan --dry-run: the band, the honesty note, no submit ----
  const pdEnv = { GEMCATCH_HOME: path.join(HOME, 'plan-dry') };
  const pd = await out(['research', 'preview a plan', '--agent', 'deep-research', '--plan', '--dry-run'], { env: pdEnv });
  assert(
    /Agent deep-research-preview-04-2026 \(planning turn\) — estimated \$1\.00–\$3\.00 for this task \(the docs price per task and do not price a planning turn separately\)\. Nothing submitted \(--dry-run\)\./.test(pd),
    `a planning dry-run quotes the SAME band and says the docs do not price planning separately: ${pd}`
  );
  assert(!/cheaper|less|discount/i.test(pd), 'the guard must never imply planning is cheaper');
  assert.strictEqual(taskCount(pdEnv.GEMCATCH_HOME), 0, 'a planning dry-run submits nothing');
  ok('research --agent --plan --dry-run prints the per-task band with the planning-turn note and submits nothing');

  // ---- the whole chain: plan -> get -> refine -> approve, in one store ----
  const chEnv = { GEMCATCH_HOME: path.join(HOME, 'chain') };
  const chRun = await cli(
    ['research', 'map the EU AI Act high-risk obligations against the UK approach', '--agent', 'deep-research', '--plan', '-t', 'euuk'],
    { env: Object.assign({}, chEnv, { GEMCATCH_ASSUME_TTY: '1' }), stdin: 'y\n' }
  );
  const planId = planIdOf(chRun.stdout);
  assert(planId, `--plan should submit a plan task: ${chRun.stdout}`);
  assert(
    /Agent deep-research-preview-04-2026 \(planning turn\) — estimated \$1\.00–\$3\.00 for this task \(preview rates, subject to change; the docs price per task and do not price a planning turn separately\)\./.test(chRun.stderr),
    `the planning confirmation quotes the per-task band and refuses to imply a discount: ${chRun.stderr}`
  );
  assert(chRun.stdout.includes(`Run: gemcatch get ${planId} when ready.`), 'the next step is spelled out');
  const planRow = qget(
    chEnv.GEMCATCH_HOME,
    'SELECT kind, agent, tag, collaborative_planning, parent_id, previous_interaction_id, interaction_id FROM tasks WHERE id = ?',
    planId
  );
  assert.strictEqual(planRow.kind, 'plan', "the row is stored with kind='plan'");
  assert.strictEqual(planRow.collaborative_planning, 1, 'and records the flag it was submitted with');
  assert.strictEqual(planRow.parent_id, null, 'a first plan continues nothing');
  assert.strictEqual(planRow.previous_interaction_id, null, 'and names no previous interaction');
  const planWire = interactions.get(planRow.interaction_id);
  assert.strictEqual(planWire.planning, true, 'agent_config.collaborative_planning reached the API as true');
  assert.strictEqual(planWire.previousInteractionId, undefined, 'a first plan sends no previous_interaction_id');
  ok('research --agent --plan submits a collaborative-planning turn and stores it as a plan');

  // get on a completed plan prints the plan and the literal next command
  await out(['get', planId], { env: chEnv }); // first poll: still in_progress
  const planGet = await cli(['get', planId], { env: chEnv });
  assert(planGet.stdout.includes('Research plan:'), `get should print the plan text: ${planGet.stdout}`);
  assert(!planGet.stdout.includes(AGENT_ANSWER), 'a plan turn returns no report');
  assert(
    planGet.stderr.includes(`Approve with: gemcatch approve ${planId}`) &&
      planGet.stderr.includes(`Refine with: gemcatch refine ${planId} "..."`),
    `get on a plan names both next commands: ${planGet.stderr}`
  );
  assert(!planGet.stdout.includes('Approve with:'), 'the guidance stays off stdout so `get > plan.md` is clean');
  const planJson = JSON.parse(await out(['get', planId, '--json'], { env: chEnv }));
  assert.strictEqual(planJson.kind, 'plan', 'get --json marks a plan as one');
  assert.strictEqual(planJson.approve, `gemcatch approve ${planId}`, 'and carries the approve command');
  assert.strictEqual(planJson.refine, `gemcatch refine ${planId} "<instruction>"`, 'and the refine command');
  ok('get on a completed plan prints the plan and then the approve/refine commands');

  // refine: a second plan turn, linked to the first
  const rfRun = await cli(['refine', planId, 'focus on enforcement dates, drop the history'], {
    env: Object.assign({}, chEnv, { GEMCATCH_ASSUME_TTY: '1' }),
    stdin: 'y\n',
  });
  const refineId = planIdOf(rfRun.stdout);
  assert(refineId, `refine should submit a new plan task: ${rfRun.stdout}`);
  assert(rfRun.stdout.includes(`(refines ${planId})`), 'and say what it refines');
  assert(/\(planning turn\)/.test(rfRun.stderr), 'a refine is a planning turn and is priced as one');
  const rfRow = qget(
    chEnv.GEMCATCH_HOME,
    'SELECT kind, agent, tag, collaborative_planning, parent_id, previous_interaction_id, interaction_id FROM tasks WHERE id = ?',
    refineId
  );
  assert.strictEqual(rfRow.kind, 'plan', 'a refine stores another plan row');
  assert.strictEqual(rfRow.parent_id, planId, 'linked to the plan it refines');
  assert.strictEqual(rfRow.previous_interaction_id, planRow.interaction_id, "and to that plan's interaction");
  assert.strictEqual(rfRow.agent, 'deep-research-preview-04-2026', 'the agent is inherited');
  assert.strictEqual(rfRow.tag, 'euuk', 'and so is the tag');
  const rfWire = interactions.get(rfRow.interaction_id);
  assert.strictEqual(rfWire.planning, true, 'a refine keeps collaborative_planning true');
  assert.strictEqual(rfWire.previousInteractionId, planRow.interaction_id, 'previous_interaction_id reached the API');
  await out(['get', refineId], { env: chEnv }); // first poll
  const rfGet = await out(['get', refineId], { env: chEnv });
  assert(
    rfGet.includes('(revised: focus on enforcement dates, drop the history)'),
    `the refined plan reflects the instruction the server received: ${rfGet}`
  );
  ok('refine chains a second planning turn onto the first, inheriting agent and tag');

  // approve: the report turn, priced without the planning note
  const apRun = await cli(['approve', refineId], {
    env: Object.assign({}, chEnv, { GEMCATCH_ASSUME_TTY: '1' }),
    stdin: 'y\n',
  });
  const reportId = approveIdOf(apRun.stdout);
  assert(reportId, `approve should submit the research run: ${apRun.stdout}`);
  assert(apRun.stdout.includes(`(approves plan ${refineId})`), 'and say which plan it approves');
  assert(
    /Agent deep-research-preview-04-2026 — estimated \$1\.00–\$3\.00 for this task \(preview rates, subject to change\)\./.test(apRun.stderr),
    `the approval turn quotes the ordinary band: ${apRun.stderr}`
  );
  assert(!/planning turn/.test(apRun.stderr), 'and is not a planning turn');
  const rpRow = qget(
    chEnv.GEMCATCH_HOME,
    'SELECT kind, prompt, agent, tag, collaborative_planning, parent_id, previous_interaction_id, interaction_id FROM tasks WHERE id = ?',
    reportId
  );
  assert.strictEqual(rpRow.kind, 'report', "an approved run is stored with kind='report'");
  assert.strictEqual(rpRow.collaborative_planning, 0, 'and records collaborative_planning false');
  assert.strictEqual(rpRow.parent_id, refineId, 'linked to the plan it approves');
  assert.strictEqual(rpRow.previous_interaction_id, rfRow.interaction_id, "and to that plan's interaction");
  assert.strictEqual(rpRow.tag, 'euuk', 'the tag follows the chain');
  assert(
    rpRow.prompt.startsWith('map the EU AI Act'),
    `the report is filed under the question that started the chain, not the approval line: ${rpRow.prompt}`
  );
  const rpWire = interactions.get(rpRow.interaction_id);
  assert.strictEqual(rpWire.planning, false, 'the approval turn sends collaborative_planning false');
  assert.strictEqual(rpWire.previousInteractionId, rfRow.interaction_id, 'and continues the refined plan');
  assert(/Plan looks good/.test(rpWire.prompt), 'the wire input is a short approval, not the question again');
  await out(['get', reportId], { env: chEnv }); // first poll
  const rpGet = await out(['get', reportId], { env: chEnv });
  assert(rpGet.includes(AGENT_ANSWER), `an approved run returns the report: ${rpGet}`);
  assert(rpGet.includes('Sources:'), 'with its citations');
  ok('approve submits the research run with collaborative_planning false and returns the report');

  // ---- list renders the chain indented under its root ----
  const chList = await out(['list'], { env: chEnv });
  assert(/KIND/.test(chList), `a store containing plans grows a KIND column: ${chList}`);
  const chLines = chList.trim().split('\n');
  const lineFor = (tid) => chLines.find((l) => l.startsWith(tid));
  assert(lineFor(planId) && !/└─/.test(lineFor(planId)), 'the root of the chain is not indented');
  assert(/└─ /.test(lineFor(refineId)), `a refine is indented under its plan: ${lineFor(refineId)}`);
  assert(/ {2}└─ /.test(lineFor(reportId)), `the report is indented one deeper again: ${lineFor(reportId)}`);
  assert(
    chLines.indexOf(lineFor(planId)) < chLines.indexOf(lineFor(refineId)) &&
      chLines.indexOf(lineFor(refineId)) < chLines.indexOf(lineFor(reportId)),
    'a chain reads forward in time under its root'
  );
  assert(/\breport\b/.test(lineFor(reportId)) && /\bplan\b/.test(lineFor(planId)), 'the KIND column names each turn');
  ok('list renders a plan chain indented under its root, in submission order');

  // ---- list never loses a row, even to a parent_id cycle ----
  // Nothing the CLI writes can make one, but a row unreachable from any root
  // would otherwise vanish from the listing rather than crash.
  const cyEnv = { GEMCATCH_HOME: path.join(HOME, 'cycle') };
  fs.mkdirSync(cyEnv.GEMCATCH_HOME, { recursive: true });
  const cyDb = new Database(path.join(cyEnv.GEMCATCH_HOME, 'tasks.db'));
  cyDb.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT, interaction_id TEXT, status TEXT DEFAULT 'pending', " +
      'result TEXT, created_at INTEGER, model TEXT, system_instruction TEXT, tag TEXT, error TEXT, usage TEXT, ' +
      "updated_at INTEGER, agent TEXT, citations TEXT, collaborative_planning INTEGER, " +
      "previous_interaction_id TEXT, kind TEXT DEFAULT 'task', parent_id TEXT)"
  );
  const insCy = cyDb.prepare('INSERT INTO tasks (id, prompt, status, created_at, kind, parent_id) VALUES (?,?,?,?,?,?)');
  insCy.run('cyc00001', 'points at the other one', 'completed', 100, 'plan', 'cyc00002');
  insCy.run('cyc00002', 'points back at the first', 'completed', 200, 'plan', 'cyc00001');
  insCy.run('cyc00003', 'an ordinary root', 'completed', 300, 'task', null);
  cyDb.close();
  const cyList = await out(['list'], { env: cyEnv });
  for (const cid of ['cyc00001', 'cyc00002', 'cyc00003']) {
    assert(cyList.includes(cid), `every row is still rendered exactly once: ${cid} missing from ${cyList}`);
  }
  assert.strictEqual((cyList.match(/cyc00001/g) || []).length, 1, 'and exactly once');
  ok('list renders every row even when parent_id is unreachable from any root');

  // ---- export follows the chain to the report and skips the plans ----
  const chExport = await out(['export', '--tag', 'euuk'], { env: chEnv });
  assert(chExport.includes(AGENT_ANSWER), `export emits the report: ${chExport}`);
  assert(!chExport.includes('Research plan:'), 'and not the plan turns it went through');
  assert(chExport.includes('## map the EU AI Act'), 'filed under the question that started the chain');
  const chExportAll = await out(['export', '--tag', 'euuk', '--include-plans'], { env: chEnv });
  assert(chExportAll.includes('Research plan:'), '--include-plans brings the plan turns back');
  assert(chExportAll.includes(AGENT_ANSWER), 'alongside the report');
  assert(/· plan ·/.test(chExportAll), 'and labels which turn each section was');
  const chExportJson = JSON.parse(await out(['export', '--tag', 'euuk', '--format', 'json'], { env: chEnv }));
  assert.strictEqual(chExportJson.length, 1, 'the json export is the report alone');
  assert.strictEqual(chExportJson[0].kind, 'report', 'and says so');
  ok('export follows a chain to its report and skips intermediate plans unless --include-plans');

  // ---- approving the same plan twice makes a second report row ----
  const ap2 = await cli(['approve', refineId, '--yes'], { env: chEnv });
  const report2 = approveIdOf(ap2.stdout);
  assert(report2 && report2 !== reportId, `a second approve is a second run, not a silent reuse: ${ap2.stdout}`);
  const chReports = qall(chEnv.GEMCATCH_HOME, "SELECT id FROM tasks WHERE kind = 'report' AND parent_id = ?", refineId);
  assert.strictEqual(chReports.length, 2, 'both report rows are stored');
  const chList2 = await out(['list'], { env: chEnv });
  assert(chList2.includes(reportId) && chList2.includes(report2), 'and list shows both');
  ok('approving the same plan twice creates a second report row and list shows both');

  // ---- stats tallies the chain and totals what it plausibly cost ----
  // A chain bills per turn, so the running total has to count the plans too --
  // that is the number a spend-guarded tool owes its user.
  const chStats = JSON.parse(await out(['stats', '--json'], { env: chEnv }));
  assert.deepStrictEqual(
    chStats.by_kind.slice().sort((a, b) => a.kind.localeCompare(b.kind)),
    [{ kind: 'plan', n: 2 }, { kind: 'report', n: 2 }],
    `stats tallies plan and report turns: ${JSON.stringify(chStats.by_kind)}`
  );
  assert.strictEqual(chStats.estimated_spend.tasks, 4, 'every agent turn is billed, plans included');
  assert.strictEqual(chStats.estimated_spend.low, 4, '4 turns at the $1.00 floor');
  assert.strictEqual(chStats.estimated_spend.high, 12, 'and the $3.00 ceiling');
  const chStatsHuman = await out(['stats'], { env: chEnv });
  assert(/Plan chains: /.test(chStatsHuman), `the human view names the chain turns: ${chStatsHuman}`);
  assert(
    /Estimated spend: \$4\.00–\$12\.00 across 4 billed task\(s\) \(preview rates, subject to change\)\./.test(chStatsHuman),
    `and totals them with the docs' hedge: ${chStatsHuman}`
  );
  const plainStats = await out(['stats'], { env: xpEnv });
  assert(!/Plan chains|Estimated spend/.test(plainStats), `a store with no agent runs says neither: ${plainStats}`);
  ok('stats tallies plan/report turns and totals the estimated spend across every billed turn');

  // ---- approve --dry-run: the band, and nothing sent ----
  const beforeDry = interactions.size;
  const apDry = await out(['approve', refineId, '--dry-run'], { env: chEnv });
  assert(
    /Agent deep-research-preview-04-2026 — estimated \$1\.00–\$3\.00 for this task\. Nothing submitted \(--dry-run\)\./.test(apDry),
    `approve --dry-run prints the band: ${apDry}`
  );
  assert.strictEqual(interactions.size, beforeDry, 'approve --dry-run sends nothing');
  assert.strictEqual(
    qall(chEnv.GEMCATCH_HOME, "SELECT id FROM tasks WHERE kind = 'report'").length,
    2,
    'and writes no row'
  );
  ok('approve --dry-run prints the band, sends nothing and writes nothing');

  // ---- approve/refine in a non-TTY: --yes required, and honoured ----
  const ntaEnv = { GEMCATCH_HOME: path.join(HOME, 'plan-notty') };
  const nta = await cli(['research', 'scripted plan', '--agent', 'deep-research', '--plan', '--yes'], { env: ntaEnv });
  const ntaPlan = planIdOf(nta.stdout);
  await out(['get', ntaPlan], { env: ntaEnv });
  await out(['get', ntaPlan], { env: ntaEnv }); // drive it to completed
  const ntaRefused = await cli(['approve', ntaPlan], { env: ntaEnv }).catch((e) => e);
  assert.strictEqual(ntaRefused.code, 1, 'approve in a non-TTY without --yes must refuse');
  assert(/stdin is not a TTY/.test(ntaRefused.stderr) && /--yes/.test(ntaRefused.stderr), `the refusal names the fix: ${ntaRefused.stderr}`);
  assert.strictEqual(
    qall(ntaEnv.GEMCATCH_HOME, "SELECT id FROM tasks WHERE kind = 'report'").length,
    0,
    'a refused approve writes no row'
  );
  const ntaOk = await cli(['approve', ntaPlan, '--yes'], { env: ntaEnv });
  assert(approveIdOf(ntaOk.stdout), `--yes confirms it in a script: ${ntaOk.stdout}`);
  ok('approve refuses a non-TTY without --yes and honours --yes with it');

  // ---- approve on a task that is not a plan: fails fast, sends nothing ----
  const npEnv = { GEMCATCH_HOME: path.join(HOME, 'not-a-plan') };
  const npId = await submit('an ordinary task', [], { env: npEnv });
  const beforeNp = interactions.size;
  const np = await cli(['approve', npId, '--yes'], { env: npEnv }).catch((e) => e);
  assert.strictEqual(np.code, 1, 'approve on a non-plan exits non-zero');
  assert(/is not a plan \(kind: task\)/.test(np.stderr), `the message says what it is: ${np.stderr}`);
  assert(/--plan/.test(np.stderr), 'and how to make one');
  assert.strictEqual(interactions.size, beforeNp, 'and nothing was submitted');
  const npRefine = await cli(['refine', npId, 'do it differently', '--yes'], { env: npEnv }).catch((e) => e);
  assert.strictEqual(npRefine.code, 1, 'refine is gated the same way');
  assert(/is not a plan/.test(npRefine.stderr), `refine explains too: ${npRefine.stderr}`);
  ok('approve (and refine) on a task that is not a plan fails fast and submits nothing');

  // ---- approve on a plan that has not completed: fails fast, sends nothing ----
  const ipEnv = { GEMCATCH_HOME: path.join(HOME, 'plan-pending') };
  const ipRun = await cli(['research', 'SLOW plan still running', '--agent', 'deep-research', '--plan', '--yes'], { env: ipEnv });
  const ipId = planIdOf(ipRun.stdout);
  const beforeIp = interactions.size;
  const ip = await cli(['approve', ipId, '--yes'], { env: ipEnv }).catch((e) => e);
  assert.strictEqual(ip.code, 1, 'approve on an unfinished plan exits non-zero');
  assert(/has not completed yet \(status: in_progress\)/.test(ip.stderr), `the message names the status: ${ip.stderr}`);
  assert(new RegExp(`gemcatch watch ${ipId}`).test(ip.stderr), 'and how to wait for it');
  assert.strictEqual(interactions.size, beforeIp, 'and nothing was submitted');
  ok('approve on a plan that has not completed fails fast and submits nothing');

  // ---- approve on a plan the server has already dropped ----
  // Retired to `incomplete` by the 404 path: name the retention window rather
  // than send a previous_interaction_id the server is going to reject.
  const xpPlanEnv = { GEMCATCH_HOME: path.join(HOME, 'plan-expired') };
  const xpRun = await cli(['research', 'SLOW plan that expires', '--agent', 'deep-research', '--plan', '--yes'], { env: xpPlanEnv });
  const xpId = planIdOf(xpRun.stdout);
  interactions.delete(qget(xpPlanEnv.GEMCATCH_HOME, 'SELECT interaction_id FROM tasks WHERE id = ?', xpId).interaction_id);
  await cliTimeout(['daemon', '-i', '0.05', '--exit-when-idle', '--json'], { env: xpPlanEnv }, 15000);
  assert.strictEqual(
    qget(xpPlanEnv.GEMCATCH_HOME, 'SELECT status FROM tasks WHERE id = ?', xpId).status,
    'incomplete',
    'the 404 retires the plan exactly as it retires any other task'
  );
  const beforeXp = prevRejects;
  const xp = await cli(['approve', xpId, '--yes'], { env: xpPlanEnv }).catch((e) => e);
  assert.strictEqual(xp.code, 1, 'approving a dropped plan exits non-zero');
  assert(/dropped server-side/.test(xp.stderr), `the message says what happened: ${xp.stderr}`);
  assert(/1 day on the free tier \(55 days on paid\)/.test(xp.stderr), `and names the expiry: ${xp.stderr}`);
  assert.strictEqual(prevRejects - beforeXp, 0, 'and no previous_interaction_id the server would reject was sent');
  ok('approve on a plan whose interaction was dropped names the retention window and sends nothing');

  // ---- a plan that expires only AFTER it completed locally ----
  // gemcatch cannot know until the API says so, so the 404 it gets back is
  // rewritten into the same explanation instead of a bare "not found".
  const xlEnv = { GEMCATCH_HOME: path.join(HOME, 'plan-expired-late') };
  const xlRun = await cli(['research', 'a plan that outlives its interaction', '--agent', 'deep-research', '--plan', '--yes'], { env: xlEnv });
  const xlId = planIdOf(xlRun.stdout);
  await out(['get', xlId], { env: xlEnv });
  await out(['get', xlId], { env: xlEnv }); // completed and cached
  interactions.delete(qget(xlEnv.GEMCATCH_HOME, 'SELECT interaction_id FROM tasks WHERE id = ?', xlId).interaction_id);
  const beforeXl = prevRejects;
  const xl = await cli(['approve', xlId, '--yes'], { env: xlEnv }).catch((e) => e);
  assert.strictEqual(xl.code, 1, 'the API 404 surfaces as a failure');
  assert(/gone server-side/.test(xl.stderr) && /55 days on paid/.test(xl.stderr), `the 404 is explained, not passed through raw: ${xl.stderr}`);
  assert.strictEqual(prevRejects - beforeXl, 1, 'the API is what rejected it');
  ok('a plan whose interaction expires after completion explains the 404 rather than passing it through');

  // ---- batch --plan: a plan per prompt ----
  const bpFile = path.join(HOME, 'plan-batch.txt');
  fs.writeFileSync(bpFile, 'first plan question\nsecond plan question\n');
  const bplEnv = { GEMCATCH_HOME: path.join(HOME, 'batch-plan') };
  const bpl = await cli(['batch', bpFile, '--agent', 'deep-research', '--plan', '--yes', '-t', 'plans'], { env: bplEnv });
  assert(
    /2 prompts × deep-research-preview-04-2026 \(planning turn\) — estimated \$2\.00–\$6\.00 total \(preview rates, subject to change; the docs price per task and do not price a planning turn separately\)\./.test(bpl.stderr),
    `a plan batch quotes N × the per-task band with the same honesty note: ${bpl.stderr}`
  );
  assert(/approve the ones worth running/.test(bpl.stdout), `and points at the approve step: ${bpl.stdout}`);
  const bplRows = qall(bplEnv.GEMCATCH_HOME, 'SELECT kind, collaborative_planning, interaction_id FROM tasks');
  assert.strictEqual(bplRows.length, 2, 'one plan row per prompt');
  for (const r of bplRows) {
    assert.strictEqual(r.kind, 'plan', 'every batch row is a plan');
    assert.strictEqual(r.collaborative_planning, 1, 'submitted as a planning turn');
    assert.strictEqual(interactions.get(r.interaction_id).planning, true, 'and the API got the flag');
  }
  ok('batch --agent --plan submits a planning turn per prompt and points at approve');

  // ---- --plan with --watch: fine together, and the footer still appears ----
  const pwEnv = { GEMCATCH_HOME: path.join(HOME, 'plan-watch') };
  const pw = await cliTimeout(
    ['research', 'SLOW watch a plan', '--agent', 'deep-research', '--plan', '--yes', '-w'],
    { env: pwEnv },
    20000
  );
  assert.strictEqual(pw.timedOut, false, '--plan and --watch work together');
  assert.strictEqual(pw.code, 0, `a watched plan completes: ${pw.stderr}`);
  assert(pw.stdout.includes('Research plan:'), `the plan lands on stdout: ${pw.stdout}`);
  assert(/Approve with: gemcatch approve /.test(pw.stderr), `and the approve command on stderr: ${pw.stderr}`);
  ok('research --plan --watch waits for the plan and still names the approve command');

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
            assert(!(body.agent && body.model), 'SDK submit must never send agent AND model');
            assert(body.agent || body.model, 'SDK submit must send one of agent or model');
            const id = `sdk_${++sdkSeq}`;
            sdkState.set(id, { polls: /SLOW/.test(body.input) ? 1 : 0, boom: /BOOM/.test(body.input), agent: body.agent });
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
            // An agent run through the SDK: multi-step, report last, citations
            // attached -- shape() must read it the same way it reads REST.
            if (s.agent) {
              return {
                id,
                agent: s.agent,
                status: 'completed',
                usage: { total_tokens: 900 },
                steps: [
                  { type: 'user_input', content: [{ type: 'text', text: 'the question' }] },
                  { type: 'model_output', content: [{ type: 'text', text: 'interim notes' }] },
                  { type: 'model_output', content: [{ type: 'text', text: AGENT_ANSWER }], citations: AGENT_CITATIONS },
                ],
              };
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

    // The agent path through the SDK: `agent` on create, no `model`, and the
    // final-step report with citations coming back through shape().
    const sa = await sdk.submit('deep dive', { agent: 'deep-research-preview-04-2026' });
    const sp = await sdk.poll(sa.interactionId);
    assert.strictEqual(sp.status, 'completed');
    assert.strictEqual(sp.text, AGENT_ANSWER, 'the SDK agent run yields only the final-step report');
    assert.deepStrictEqual(sp.citations, AGENT_CITATIONS, 'citations survive the SDK path');

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
