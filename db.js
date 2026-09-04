'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { PENDING, TERMINAL } = require('./status');

// GEMCATCH_HOME lets tests and power users relocate the store.
const HOME = process.env.GEMCATCH_HOME || path.join(os.homedir(), '.gemcatch');
const DB_PATH = path.join(HOME, 'tasks.db');

// The v1 shape. Never change this -- migrations below carry it forward, so an
// old tasks.db keeps opening cleanly.
const BASE_SCHEMA =
  'CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT, ' +
  "interaction_id TEXT, status TEXT DEFAULT 'pending', result TEXT, created_at INTEGER)";

// Columns added after v1. Additive only: SQLite can ALTER TABLE ADD COLUMN but
// not drop or retype, so anything here must be nullable.
const MIGRATIONS = [
  ['model', 'TEXT'],
  ['system_instruction', 'TEXT'],
  ['tag', 'TEXT'],
  ['error', 'TEXT'],
  ['usage', 'TEXT'],
  ['updated_at', 'INTEGER'],
  // 0.4.0: agent runs. `agent` is the resolved agent id the task was submitted
  // with (NULL for model runs, including every pre-0.4.0 row); `citations` is
  // the JSON array of sources an agent run returned alongside its report.
  ['agent', 'TEXT'],
  ['citations', 'TEXT'],
  // 0.5.0: collaborative planning. `collaborative_planning` is the agent_config
  // flag the row was submitted with (1 plan turn, 0 report turn, NULL for every
  // run that sent no agent_config at all, including every pre-0.5.0 row);
  // `previous_interaction_id` is the interaction this turn continues;
  // `kind` is 'task' | 'plan' | 'report'; `parent_id` is the local task this
  // turn continues. The DEFAULT backfills 'task' for older rows, so a 0.4.0
  // store keeps behaving exactly as it did.
  ['collaborative_planning', 'INTEGER'],
  ['previous_interaction_id', 'TEXT'],
  ['kind', "TEXT DEFAULT 'task'"],
  ['parent_id', 'TEXT'],
];

let _db = null;

function migrate(d) {
  const have = new Set(d.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name));
  for (const [name, type] of MIGRATIONS) {
    if (!have.has(name)) d.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
  }
  d.exec('CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks (created_at DESC)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)');
}

function db() {
  if (_db) return _db;
  fs.mkdirSync(HOME, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(BASE_SCHEMA);
  migrate(_db);
  return _db;
}

function newId() {
  return crypto.randomUUID().slice(0, 8);
}

function createTask(fields) {
  const t = fields || {};
  const id = newId();
  const now = Date.now();
  db()
    .prepare(
      'INSERT INTO tasks (id, prompt, status, created_at, updated_at, model, system_instruction, tag, agent, ' +
        'kind, parent_id, collaborative_planning, previous_interaction_id) ' +
        'VALUES (@id, @prompt, @status, @now, @now, @model, @system_instruction, @tag, @agent, ' +
        '@kind, @parent_id, @collaborative_planning, @previous_interaction_id)'
    )
    .run({
      id,
      prompt: t.prompt,
      status: PENDING,
      now,
      model: t.model || null,
      system_instruction: t.systemInstruction || null,
      tag: t.tag || null,
      agent: t.agent || null,
      kind: t.kind || 'task',
      parent_id: t.parentId || null,
      // Presence, not truthiness: `false` is the report turn's real flag and
      // must be stored as 0, while a run that sends no agent_config stores NULL.
      collaborative_planning: t.collaborativePlanning === undefined ? null : Number(!!t.collaborativePlanning),
      previous_interaction_id: t.previousInteractionId || null,
    });
  return id;
}

// Exact id first, then unique-prefix match so short ids stay forgiving.
// Returns null for no match; throws on an ambiguous prefix rather than
// silently picking one.
function getTask(id) {
  const exact = db().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (exact) return exact;
  const hits = db().prepare('SELECT * FROM tasks WHERE id LIKE ? ORDER BY created_at DESC').all(id + '%');
  if (hits.length > 1) {
    const e = new Error(`'${id}' matches ${hits.length} tasks: ${hits.map((h) => h.id).join(', ')}`);
    e.code = 'AMBIGUOUS_ID';
    throw e;
  }
  return hits[0] || null;
}

function setInteraction(id, interactionId, status) {
  db()
    .prepare('UPDATE tasks SET interaction_id = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(interactionId, status, Date.now(), id);
}

// Only overwrites result/error/usage when the caller supplies them, so a poll
// that returns no text can't blank out a result we already stored.
function setStatus(id, status, extra) {
  const e = extra || {};
  const sets = ['status = @status', 'updated_at = @now'];
  const params = { id, status, now: Date.now() };
  for (const key of ['result', 'error', 'usage', 'citations']) {
    if (e[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = e[key];
    }
  }
  db().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

function listTasks(opts) {
  const o = opts || {};
  const where = [];
  const params = {};
  if (o.status) {
    where.push('status = @status');
    params.status = o.status;
  }
  if (o.tag) {
    where.push('tag = @tag');
    params.tag = o.tag;
  }
  let sql = 'SELECT * FROM tasks';
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY created_at DESC';
  // Presence, not truthiness: `--limit 0` is a real cap (return nothing), so it
  // must not be treated the same as "no limit given". The caller validates that
  // it is a non-negative integer before we get here.
  if (o.limit != null) {
    sql += ' LIMIT @limit';
    params.limit = o.limit;
  }
  return db().prepare(sql).all(params);
}

// In-flight tasks worth re-polling: submitted (we have an id) but not final.
function activeTasks() {
  const marks = TERMINAL.map(() => '?').join(', ');
  return db()
    .prepare(
      `SELECT * FROM tasks WHERE interaction_id IS NOT NULL AND status NOT IN (${marks}) ORDER BY created_at ASC`
    )
    .all(...TERMINAL);
}

function removeTask(id) {
  return db().prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
}

// Finished tasks older than `beforeMs`. Never touches in-flight work.
function prunableTasks(beforeMs) {
  const marks = TERMINAL.map(() => '?').join(', ');
  return db()
    .prepare(`SELECT * FROM tasks WHERE status IN (${marks}) AND created_at < ? ORDER BY created_at ASC`)
    .all(...TERMINAL, beforeMs);
}

function removeMany(ids) {
  if (!ids.length) return 0;
  const del = db().prepare('DELETE FROM tasks WHERE id = ?');
  return db().transaction((list) => list.reduce((n, id) => n + del.run(id).changes, 0))(ids);
}

function counts() {
  return db().prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all();
}

// Per-agent totals for `stats`. Model runs (agent IS NULL) are not a row here;
// they are already accounted for in counts().
function agentCounts() {
  return db()
    .prepare('SELECT agent, COUNT(*) AS n FROM tasks WHERE agent IS NOT NULL GROUP BY agent')
    .all();
}

// Agent runs that actually reached the server, keyed by agent. A submit that
// never got an interaction_id (a bad key, a rejected agent id, a network
// failure) was never billed, so it must not appear in a spend total -- unlike
// agentCounts(), which tallies every attempt.
function billedAgentCounts() {
  return db()
    .prepare(
      'SELECT agent, COUNT(*) AS n FROM tasks WHERE agent IS NOT NULL AND interaction_id IS NOT NULL GROUP BY agent'
    )
    .all();
}

// Plan/report totals for `stats`. Ordinary tasks are not a row here; they are
// already accounted for in counts(), and a store that has never planned reports
// nothing at all.
function kindCounts() {
  return db()
    .prepare("SELECT kind, COUNT(*) AS n FROM tasks WHERE kind IS NOT NULL AND kind != 'task' GROUP BY kind")
    .all();
}

function close() {
  if (_db) _db.close();
  _db = null;
}

module.exports = {
  DB_PATH,
  HOME,
  createTask,
  getTask,
  setInteraction,
  setStatus,
  listTasks,
  activeTasks,
  removeTask,
  removeMany,
  prunableTasks,
  counts,
  agentCounts,
  billedAgentCounts,
  kindCounts,
  close,
};
