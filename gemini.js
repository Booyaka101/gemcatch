'use strict';

const { isDone, isSuccess } = require('./status');

// Free of charge on the Gemini free tier; override per-call with --model.
const DEFAULT_MODEL = process.env.GEMI_MODEL || 'gemini-3.1-flash-lite';

// Overridable for tests and for routing via a proxy/gateway.
const REST_BASE =
  process.env.GEMI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/interactions';

function envNum(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

// The free tier allows ~15 requests/minute. Capping *concurrency* does not cap
// a rate, so every outbound call goes through gate() below instead. 0 disables
// it -- paid keys, gateways, and the test suite.
const RPM = envNum('GEMI_RPM', 15);

const MAX_RETRIES = envNum('GEMI_MAX_RETRIES', 4);
const RETRY_BASE_MS = envNum('GEMI_RETRY_BASE_MS', 500);
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
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectText(v, acc);
  }
  return acc;
}

function textOf(interaction) {
  if (interaction && typeof interaction.output_text === 'string' && interaction.output_text) {
    return interaction.output_text;
  }
  return collectText(interaction && interaction.steps, []).join('\n').trim();
}

function shape(r) {
  return {
    interactionId: r.id,
    status: r.status,
    text: textOf(r),
    usage: r.usage || null,
    raw: r,
  };
}

// --- transports -----------------------------------------------------------

let _api;

function sdkInteractions() {
  // GEMI_FORCE_REST exercises the raw-fetch fallback without uninstalling the
  // SDK. Checked every call so it always wins over the memo below.
  if (process.env.GEMI_FORCE_REST === '1') return null;
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
  const body = { model: o.model || DEFAULT_MODEL, input: prompt, background: true };
  if (o.systemInstruction) body.system_instruction = o.systemInstruction;
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
  submit,
  poll,
  cancel,
  remove,
  apiKey,
  textOf,
  collectText,
  // Exported for the suite: the retry policy is behaviour worth pinning.
  shouldRetry,
  // Re-exported so callers need only one require.
  isDone,
  isSuccess,
};
