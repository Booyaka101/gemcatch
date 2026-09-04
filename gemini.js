'use strict';

const { isDone, isSuccess } = require('./status');

// Free of charge on the Gemini free tier; override per-call with --model.
// gemini-3.5-flash-lite went GA on 2026-07-21 (it replaced 3.1 as the
// low-latency free-tier workhorse in the same release that deprecated the
// sampling parameters).
const DEFAULT_MODEL = process.env.GEMCATCH_MODEL || 'gemini-3.5-flash-lite';

// --- agents ---------------------------------------------------------------

// The Deep Research agents are reachable ONLY through the Interactions API,
// and only with background execution -- which gemcatch always sets. An agent
// is sent as `agent` on create, INSTEAD of `model`: the two are mutually
// exclusive, and the CLI rejects the combination before anything is written.
//
// This table is the ONE place the full preview ids live. They are preview ids
// and will be superseded; call sites must resolve through here (or pass an
// unknown id straight through, so a future agent works without a release).
const AGENT_ALIASES = Object.freeze({
  'deep-research': 'deep-research-preview-04-2026',
  'deep-research-max': 'deep-research-max-preview-04-2026',
});

// `agent_config.type` for the config block a collaborative-planning turn sends.
// Both documented Deep Research agents use the same value, and an unknown
// pass-through id is assumed to be one too -- collaborative planning is a Deep
// Research feature, so there is nothing else it could be.
const AGENT_CONFIG_TYPE = 'deep-research';

// Documented per-task price bands, in dollars, keyed by the RESOLVED id.
// The docs' own hedge applies -- "These figures are estimates based on
// preview rates and are subject to change" -- so the spend guard quotes
// them as estimates, never as authoritative.
const AGENT_PRICE_BANDS = Object.freeze({
  'deep-research-preview-04-2026': Object.freeze([1, 3]),
  'deep-research-max-preview-04-2026': Object.freeze([3, 7]),
});

// A known alias resolves to its full preview id; anything else passes through
// unchanged so a new or newer agent id works without a gemcatch release (a
// genuinely bad id fails fast: the API 4xxes, and a 4xx never retries).
function resolveAgent(id) {
  return AGENT_ALIASES[id] || id;
}

// Overridable for tests and for routing via a proxy/gateway.
const REST_BASE =
  process.env.GEMCATCH_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/interactions';

function envNum(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

// The free tier allows ~15 requests/minute. Capping *concurrency* does not cap
// a rate, so every outbound call goes through gate() below instead. 0 disables
// it -- paid keys, gateways, and the test suite.
const RPM = envNum('GEMCATCH_RPM', 15);

const MAX_RETRIES = envNum('GEMCATCH_MAX_RETRIES', 4);
const RETRY_BASE_MS = envNum('GEMCATCH_RETRY_BASE_MS', 500);
const RETRY_CEIL_MS = 30000;

const KEY_HELP =
  'Get a free key at https://aistudio.google.com/apikey (no billing required), then:\n' +
  '  $env:GEMINI_API_KEY="..."   (PowerShell)\n' +
  '  export GEMINI_API_KEY=...   (bash)';

function apiKey() {
  const k = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!k) {
    const e = new Error(`GEMINI_API_KEY is not set.\n${KEY_HELP}`);
    e.code = 'NO_KEY';
    throw e;
  }
  return k;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- rate limiting --------------------------------------------------------

let _gateTail = Promise.resolve();
let _lastStart = 0;

// Serialises *permission to start*, not the requests themselves: callers still
// overlap once through. A fresh process starts with _lastStart = 0, so a
// one-shot command is never delayed -- only fan-out (`sync`) and loops
// (`watch`, `daemon`) ever wait here.
function gate() {
  if (RPM <= 0) return Promise.resolve();
  const minGap = 60000 / RPM;
  const turn = _gateTail.then(async () => {
    const wait = _lastStart + minGap - Date.now();
    if (wait > 0) await sleep(wait);
    _lastStart = Date.now();
  });
  _gateTail = turn.catch(() => {});
  return turn;
}

// --- errors ---------------------------------------------------------------

// Google sends Retry-After on some 429/503s. Seconds or an HTTP date.
function retryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// Google returns either {error:{...}} or [{error:{...}}]; normalise both, and
// attach the fix alongside the diagnosis. Both transports funnel through here,
// so the advice can't drift between the SDK and REST paths.
function apiError(status, body, headers) {
  const node = Array.isArray(body) ? body[0] : body;
  const detail = (node && node.error) || {};
  let msg = detail.message || `HTTP ${status}`;
  if (/API key/i.test(msg)) msg += `\n  ${KEY_HELP}`;
  if (detail.status === 'RESOURCE_EXHAUSTED' || status === 429) {
    msg +=
      '\n  Free-tier rate limit — wait a minute and retry.' +
      '\n  Limits: https://ai.google.dev/gemini-api/docs/rate-limits';
  }
  const e = new Error(msg);
  e.code = 'API_ERROR';
  e.httpStatus = status;
  const ra = retryAfterMs(headers);
  if (ra !== null) e.retryAfterMs = ra;
  return e;
}

// The SDK's own message is a stub ("400 API error occurred: {...}") but it keeps
// Google's real payload on .body as a raw JSON string. Dig the message out and
// run it through apiError so SDK failures read like REST ones.
function friendly(err) {
  if (typeof (err && err.body) === 'string') {
    try {
      const node = JSON.parse(err.body);
      const detail = ((Array.isArray(node) ? node[0] : node) || {}).error;
      if (detail && detail.message) return apiError(err.status || detail.code, { error: detail });
    } catch (_) {
      /* fall through to the original error */
    }
  }
  return err;
}

// --- retry ----------------------------------------------------------------

// Transient by nature: request timeout, rate limit, and the 5xx family. A 4xx
// is a bug in the request (bad key, bad model, unknown id) and will fail
// identically forever, so it is surfaced on the first try.
function retryableStatus(s) {
  return s === 408 || s === 429 || (s >= 500 && s <= 599);
}

function shouldRetry(err) {
  if (!err) return false;
  if (err.code === 'NO_KEY') return false;
  if (err.code === 'NETWORK') return true;
  if (typeof err.httpStatus === 'number') return retryableStatus(err.httpStatus);
  return false;
}

// Full jitter: a batch that trips the limit together must not retry in
// lockstep and trip it again. Retry-After wins when the server sent one.
function backoffMs(attempt, err) {
  if (err && err.retryAfterMs != null) return err.retryAfterMs;
  const ceiling = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CEIL_MS);
  return Math.round(Math.random() * ceiling);
}

// Every API call in this file goes through here: paced on the way in, retried
// with backoff on the way out.
async function call(fn) {
  for (let attempt = 0; ; attempt += 1) {
    await gate();
    try {
      return await fn();
    } catch (raw) {
      const err = friendly(raw);
      if (attempt >= MAX_RETRIES || !shouldRetry(err)) throw err;
      await sleep(backoffMs(attempt, err));
    }
  }
}

// --- response shaping -----------------------------------------------------

// output_text is added by the SDK, so REST responses need text pulled from steps.
function collectText(node, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, acc);
    return acc;
  }
  if (typeof node.text === 'string' && node.text.trim()) acc.push(node.text);
  for (const [k, v] of Object.entries(node)) {
    // Citations are sources *about* the answer, not answer text: an agent step
    // carries them alongside its content, and a citation's own title/snippet
    // must not be concatenated into the result. They are collected separately.
    if (k === 'citations') continue;
    if (v && typeof v === 'object') collectText(v, acc);
  }
  return acc;
}

// A REST interaction's `steps` interleaves the echoed prompt and the model's
// internal reasoning with the actual answer, each tagged by `type`:
//   [ {type:'user_input', ...}, {type:'thought', ...}, {type:'model_output', ...} ]
// Collecting text indiscriminately prepends the prompt (and any reasoning) to
// the result, so those step types are skipped.
//
// Both kinds of run put the deliverable in the FINAL answer-bearing step. A
// model run ends [user_input, thought, model_output]; an agent run's steps
// additionally interleave its plan, searches and interim drafts, and the docs
// place the finished report at `interaction.steps[-1].content[0].text`. So one
// rule serves both, with no special-casing on the agent id: take the last step
// that is not user_input/thought. If that step somehow carries no text -- an
// unexpected shape, a renamed type -- fall back to collecting across every
// answer-bearing step, so the failure mode is "too much text", never a
// silently blank result.
const NON_ANSWER_STEP = new Set(['user_input', 'thought']);

function textFromSteps(steps) {
  if (!Array.isArray(steps)) return '';
  const candidates = steps.filter((s) => !(s && NON_ANSWER_STEP.has(s.type)));
  if (!candidates.length) return '';
  const last = collectText(candidates[candidates.length - 1], []).join('\n').trim();
  if (last) return last;
  const acc = [];
  for (const step of candidates) collectText(step, acc);
  return acc.join('\n').trim();
}

// Agent runs carry citations -- the docs explicitly tell users to review them
// to verify the sources -- so they are gathered rather than discarded. The
// walk is shape-agnostic (any `citations` array anywhere in the interaction),
// because the docs do not pin down where they attach; duplicates are dropped.
function collectCitations(node, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) collectCitations(n, acc);
    return acc;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'citations' && Array.isArray(v)) {
      for (const c of v) if (c && typeof c === 'object') acc.push(c);
      continue;
    }
    if (v && typeof v === 'object') collectCitations(v, acc);
  }
  return acc;
}

function citationsOf(interaction) {
  const all = collectCitations(interaction, []);
  if (!all.length) return null;
  const seen = new Set();
  const out = [];
  for (const c of all) {
    const key = JSON.stringify(c);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

function textOf(interaction) {
  if (interaction && typeof interaction.output_text === 'string' && interaction.output_text) {
    return interaction.output_text;
  }
  return textFromSteps(interaction && interaction.steps);
}

function shape(r) {
  return {
    interactionId: r.id,
    status: r.status,
    text: textOf(r),
    citations: citationsOf(r),
    usage: r.usage || null,
    raw: r,
  };
}

// --- transports -----------------------------------------------------------

let _api;

function sdkInteractions() {
  // GEMCATCH_FORCE_REST exercises the raw-fetch fallback without uninstalling the
  // SDK. Checked every call so it always wins over the memo below.
  if (process.env.GEMCATCH_FORCE_REST === '1') return null;
  if (_api !== undefined) return _api;
  let GoogleGenAI;
  try {
    ({ GoogleGenAI } = require('@google/genai'));
  } catch (_) {
    _api = null;
    return _api;
  }
  // apiKey() throws before the memo is written, so a missing key keeps
  // reporting itself instead of being cached as "no SDK".
  const client = new GoogleGenAI({ apiKey: apiKey() });
  const i = client.interactions;
  // Only use the SDK if background is genuinely first-class here.
  _api = i && typeof i.create === 'function' && typeof i.get === 'function' ? i : null;
  return _api;
}

async function restJson(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (cause) {
    // DNS, connection refused, socket hang-up: worth another go.
    const e = new Error(`network error talking to the API: ${cause.message}`);
    e.code = 'NETWORK';
    throw e;
  }
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (_) {
      // A 200 that isn't JSON means something in the middle (proxy, captive
      // portal) answered for the API. Transient often enough to retry.
      if (res.ok) {
        const e = new Error(`the API returned a non-JSON response (HTTP ${res.status})`);
        e.code = 'NETWORK';
        throw e;
      }
    }
  }
  if (!res.ok) throw apiError(res.status, body, res.headers);
  return Array.isArray(body) ? body[0] : body;
}

// NOTE: the API key goes in x-goog-api-key. `Authorization: Bearer <key>` is
// rejected with 401 ACCESS_TOKEN_TYPE_UNSUPPORTED (it expects an OAuth2 token).
function restHeaders() {
  return { 'x-goog-api-key': apiKey(), 'Content-Type': 'application/json' };
}

// --- operations -----------------------------------------------------------

async function submit(prompt, opts) {
  const o = opts || {};
  // `agent` and `model` are mutually exclusive on create: an agent run is sent
  // with `agent` INSTEAD of `model` (the agent picks its own models). `input`
  // stays a plain string and `background` stays true either way -- agents
  // *require* background execution, which gemcatch has always set.
  const body = o.agent
    ? { agent: o.agent, input: prompt, background: true }
    : { model: o.model || DEFAULT_MODEL, input: prompt, background: true };
  if (o.systemInstruction) body.system_instruction = o.systemInstruction;
  // collaborative_planning is an `agent_config` field, NOT a top-level one, and
  // the docs send the whole block (type + thinking_summaries) with it. Sent only
  // when a plan turn is involved -- agent_config is optional otherwise, so an
  // ordinary run keeps making exactly the request it always made. Presence, not
  // truthiness: `false` is the approval turn's real value and must reach the API.
  if (o.collaborativePlanning !== undefined) {
    body.agent_config = {
      type: AGENT_CONFIG_TYPE,
      thinking_summaries: 'auto',
      collaborative_planning: !!o.collaborativePlanning,
    };
  }
  // Continues an earlier interaction server-side: the plan is already in that
  // conversation, so this turn sends only what changed.
  if (o.previousInteractionId) body.previous_interaction_id = o.previousInteractionId;
  const r = await call(() => {
    const api = sdkInteractions();
    return api
      ? api.create(body)
      : restJson(REST_BASE, { method: 'POST', headers: restHeaders(), body: JSON.stringify(body) });
  });
  return shape(r);
}

async function poll(interactionId) {
  const r = await call(() => {
    const api = sdkInteractions();
    return api
      ? api.get(interactionId)
      : restJson(`${REST_BASE}/${encodeURIComponent(interactionId)}`, {
          method: 'GET',
          headers: restHeaders(),
        });
  });
  return shape(r);
}

async function cancel(interactionId) {
  const r = await call(() => {
    const api = sdkInteractions();
    return api
      ? api.cancel(interactionId)
      : restJson(`${REST_BASE}/${encodeURIComponent(interactionId)}:cancel`, {
          method: 'POST',
          headers: restHeaders(),
        });
  });
  return shape(r);
}

async function remove(interactionId) {
  await call(() => {
    const api = sdkInteractions();
    if (api) return api.delete(interactionId);
    return restJson(`${REST_BASE}/${encodeURIComponent(interactionId)}`, {
      method: 'DELETE',
      headers: restHeaders(),
    });
  });
  return true;
}

module.exports = {
  DEFAULT_MODEL,
  REST_BASE,
  RPM,
  MAX_RETRIES,
  AGENT_ALIASES,
  AGENT_PRICE_BANDS,
  AGENT_CONFIG_TYPE,
  resolveAgent,
  submit,
  poll,
  cancel,
  remove,
  apiKey,
  textOf,
  collectText,
  citationsOf,
  // Exported for the suite: the retry policy is behaviour worth pinning.
  shouldRetry,
  // Re-exported so callers need only one require.
  isDone,
  isSuccess,
};
