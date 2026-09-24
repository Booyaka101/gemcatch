'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

// What a Deep Research agent reads besides the prompt: the tools it may call
// (the default web tools, remote MCP servers, File Search stores) and the files
// attached to the first turn.

// With no `tools` field the agent gets these three, and an explicit list is the
// whole set, so they are listed back in once any source flag is given. Code
// Execution stays under --no-web: it draws the charts and reads the CSVs.
const WEB_TOOLS = Object.freeze([{ type: 'google_search' }, { type: 'url_context' }]);
const CODE_TOOL = Object.freeze({ type: 'code_execution' });

// Input types the Interactions API documents for these content blocks
// (DocumentContent and ImageContent). Anything else is refused up front rather
// than discovered as a 400 after the spend was confirmed.
const MIME_BY_EXT = Object.freeze({
  '.pdf': ['document', 'application/pdf'],
  '.csv': ['document', 'text/csv'],
  '.png': ['image', 'image/png'],
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.webp': ['image', 'image/webp'],
  '.heic': ['image', 'image/heic'],
  '.heif': ['image', 'image/heif'],
  '.gif': ['image', 'image/gif'],
  '.bmp': ['image', 'image/bmp'],
});
const TYPE_BY_MIME = Object.freeze(
  Object.fromEntries(Object.values(MIME_BY_EXT).map(([type, mime]) => [mime, type]))
);
const SUPPORTED = Object.keys(MIME_BY_EXT).join(' ');
const EXPORT_AS = Object.freeze({
  '.txt': 'PDF',
  '.md': 'PDF',
  '.rtf': 'PDF',
  '.doc': 'PDF',
  '.docx': 'PDF',
  '.odt': 'PDF',
  '.ppt': 'PDF',
  '.pptx': 'PDF',
  '.html': 'PDF',
  '.htm': 'PDF',
  '.xls': 'CSV',
  '.xlsx': 'CSV',
  '.ods': 'CSV',
  '.tsv': 'CSV',
});

// file-input-methods: inline data is capped per request, not per file, at
// 100 MB, or 50 MB once a PDF is in it. Decimal megabytes, the smaller reading.
const INLINE_LIMIT = 100 * 1000 * 1000;
const PDF_INLINE_LIMIT = 50 * 1000 * 1000;
// Files API: 2 GB per file, kept for 48 hours.
const UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024;
// Room left in the inline budget for the prompt and the JSON around the blocks.
const INLINE_HEADROOM = 1000 * 1000;
const UPLOAD_TTL_MS = 48 * 3600 * 1000;

const MASK = '***';

function fail(message) {
  const e = new Error(message);
  e.code = 'BAD_SOURCE';
  return e;
}

// --- MCP ------------------------------------------------------------------

// --mcp-name/--mcp-header/--mcp-allow modify the --mcp before them, so the
// four parsers share one list and see the flags in argv order. A modifier with
// no --mcp before it is remembered and reported by resolve(), never thrown from
// a parser: commander would echo the argument, which may be a secret header.
function mcpOptionParsers() {
  const servers = [];
  const state = { servers, orphan: null };
  const onLast = (flag, apply) => (value) => {
    const last = servers[servers.length - 1];
    if (last) apply(last, value);
    else state.orphan = state.orphan || flag;
    return state;
  };
  return {
    mcp: (url) => {
      servers.push({ url, name: null, headers: [], allow: [] });
      return state;
    },
    name: onLast('--mcp-name', (s, v) => (s.name = v)),
    header: onLast('--mcp-header', (s, v) => s.headers.push(v)),
    allow: onLast('--mcp-allow', (s, v) => s.allow.push(v)),
  };
}

function parseHeader(raw) {
  const i = raw.indexOf(':');
  const name = i > 0 ? raw.slice(0, i).trim() : '';
  const value = i > 0 ? raw.slice(i + 1).trim() : '';
  const valid = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
  if (!valid || !value) {
    // Only a valid header name is ever echoed: anything else may be a token.
    const got = valid ? `got '${name}: ...'` : 'got no header name before a colon';
    throw fail(`--mcp-header needs 'Name: value' (${got})`);
  }
  return [name, value];
}

function parseHeaders(list) {
  const headers = {};
  const seen = new Set();
  for (const [name, value] of list.map(parseHeader)) {
    if (seen.has(name.toLowerCase())) throw fail(`--mcp-header ${name} is given twice for one --mcp`);
    seen.add(name.toLowerCase());
    headers[name] = value;
  }
  return headers;
}

// ${NAME} in a header value is read from the environment when a turn is sent,
// so the store only ever holds the reference.
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandEnv(value, onMissing) {
  return String(value).replace(ENV_REF, (ref, name) => process.env[name] || onMissing(name, ref));
}

// The tools as they go on the wire. Throws in one line naming a variable that
// is not set, so callers run it before the spend guard.
function withEnv(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t) => {
    if (!t || t.type !== 'mcp_server' || !t.headers) return t;
    const headers = {};
    for (const [k, v] of Object.entries(t.headers)) {
      headers[k] = expandEnv(v, (name) => {
        throw fail(`--mcp-header ${k} for ${t.name} reads \${${name}}, which is not set`);
      });
    }
    return { ...t, headers };
  });
}

function urlOrNull(raw) {
  try {
    return new URL(raw);
  } catch (_) {
    return null;
  }
}

function decoded(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

// A URL with its user, password, query and fragment masked, for anything
// printed or stored in a listing.
function shownUrl(raw) {
  const url = urlOrNull(raw);
  if (!url) return String(raw).replace(/\/\/[^/]*@/, `//${MASK}@`).replace(/([?#]).*$/, `$1${MASK}`);
  if (!url.username && !url.password && !url.search && !url.hash) return raw;
  const mark = 'GEMCATCHMASKED';
  if (url.username) url.username = mark;
  if (url.password) url.password = mark;
  if (url.search) url.search = mark;
  if (url.hash) url.hash = mark;
  return url.toString().split(mark).join(MASK);
}

// The parts of a URL that may carry a credential, raw and decoded.
function urlSecrets(raw) {
  const url = urlOrNull(raw);
  if (!url) return [];
  // A fragment can carry key=value pairs too (#access_token=...).
  const values = (s) => s.split('&').map((p) => p.slice(p.indexOf('=') + 1));
  return [url.username, url.password, ...values(url.search.slice(1)), ...values(url.hash.slice(1))]
    .flatMap((p) => [p, decoded(p), decoded(p.replace(/\+/g, ' '))])
    .filter(Boolean);
}

function parseUrl(s) {
  const url = urlOrNull(s.url);
  if (!url) throw fail(`--mcp ${shownUrl(s.url)}: not a URL`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw fail(`--mcp ${shownUrl(s.url)}: must be an http(s) URL`);
  return url;
}

function mcpTool(s, name) {
  const tool = { type: 'mcp_server', name, url: s.url };
  if (s.headers.length) tool.headers = parseHeaders(s.headers);
  const allowed = s.allow.flatMap((v) => v.split(',')).map((t) => t.trim()).filter(Boolean);
  if (s.allow.length && !allowed.length) throw fail(`--mcp-allow for ${name} lists no tools`);
  // The API takes allowed_tools as a list of {mode?, tools} objects, not bare names.
  if (allowed.length) tool.allowed_tools = [{ tools: allowed }];
  return tool;
}

// Explicit --mcp-name values are taken first, so a name derived from the host
// steps around them (host-2, host-3) instead of colliding.
function mcpNames(servers) {
  const taken = new Set();
  for (const s of servers) {
    if (!s.name) continue;
    if (taken.has(s.name)) throw fail(`--mcp-name ${s.name} is used twice`);
    taken.add(s.name);
  }
  return servers.map((s) => {
    const host = parseUrl(s).hostname;
    if (s.name) return s.name;
    let name = host;
    for (let n = 2; taken.has(name); n += 1) name = `${host}-${n}`;
    taken.add(name);
    return name;
  });
}

function privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

// Google's servers call the MCP URL, not this machine, so a local address can
// never be reached. Worth a line, not a refusal: a tunnel may map it.
function unreachableFromGoogle(raw) {
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const kind = net.isIP(host);
  if (kind === 4) return privateV4(host);
  if (kind !== 6) return false;
  // The URL parser writes ::ffff:127.0.0.1 as ::ffff:7f00:1.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const [hi, lo] = mapped.slice(1).map((h) => parseInt(h, 16));
    return privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
  }
  return host === '::' || host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

// --- tools ----------------------------------------------------------------

function fileSearchName(store) {
  const s = store.trim();
  if (!s) throw fail('--file-search needs a store name');
  return s.includes('/') ? s : `fileSearchStores/${s}`;
}

// The `tools` array for the request, or undefined when no source flag was given
// so a plain agent run keeps sending no tools field at all.
function buildTools(servers, stores, web) {
  if (!servers.length && !stores.length && web !== false) return undefined;
  const names = mcpNames(servers);
  const tools = web === false ? [CODE_TOOL] : WEB_TOOLS.concat(CODE_TOOL);
  const out = tools.map((t) => ({ ...t })).concat(servers.map((s, i) => mcpTool(s, names[i])));
  if (stores.length) out.push({ type: 'file_search', file_search_store_names: stores.map(fileSearchName) });
  return out;
}

// A copy of a tools array that is safe to print or store in a listing.
function redactTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t) => {
    if (!t || t.type !== 'mcp_server') return t;
    const shown = { ...t, url: shownUrl(t.url) };
    if (t.headers && typeof t.headers === 'object') {
      shown.headers = Object.fromEntries(Object.keys(t.headers).map((k) => [k, MASK]));
    }
    return shown;
  });
}

function redactToolsJson(raw) {
  if (!raw) return raw;
  try {
    return JSON.stringify(redactTools(JSON.parse(raw)));
  } catch (_) {
    return null;
  }
}

// A header value as sent, the credential in a 'Bearer <token>' shape, and the
// value of each ${VAR} it reads.
function headerSecrets(value) {
  const v = expandEnv(value, (_, ref) => ref);
  const space = v.indexOf(' ');
  const vars = [...String(value).matchAll(ENV_REF)].map((m) => process.env[m[1]]).filter(Boolean);
  return [v, ...(space > 0 ? [v.slice(space + 1).trim()] : []), ...vars];
}

// Header values and URL credentials, longest first so a value is scrubbed whole
// before any shorter piece of it. Anything shorter than 8 characters is left
// alone: scrubbing a value like "1" or "json" would garble the text around it.
function secrets(tools, urls) {
  const found = (Array.isArray(tools) ? tools : [])
    .filter((t) => t && t.type === 'mcp_server')
    .flatMap((t) => [...Object.values(t.headers || {}).flatMap(headerSecrets), ...urlSecrets(t.url)])
    .concat((urls || []).flatMap(urlSecrets));
  return [...new Set(found.map(String))].filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
}

const URL_IN_TEXT = /(?:https?|ftp):\/\/[^\s"'<>\\]*[^\s"'<>\\.,;:!?)\]}*]/gi;

// Scrubs secrets out of text that is about to be printed or stored, such as an
// API error that quotes the request back: plain, JSON-escaped and URL-encoded.
// `urls` are attachment URLs, which may carry a signed query. A stored one is
// already masked, so any URL in the text naming the same resource is masked too.
function redactText(text, tools, urls) {
  let s = String(text);
  for (const v of secrets(tools, urls)) {
    for (const form of new Set([v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)])) s = s.split(form).join(MASK);
  }
  const known = (urls || []).map(urlOrNull).filter(Boolean);
  const same = (u) => u && known.some((k) => k.host === u.host && k.pathname === u.pathname);
  return known.length ? s.replace(URL_IN_TEXT, (u) => (same(urlOrNull(u)) ? shownUrl(u) : u)) : s;
}

// --- attachments ----------------------------------------------------------

function typeFromExt(name) {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] || null;
}

// The docs' own document example (arxiv.org/pdf/1706.03762) has no extension,
// so an https URL without one is asked for its Content-Type. `fetchImpl` is
// injectable for the offline suite.
async function sniffUrl(spec, fetchImpl) {
  const ask = (init) => (fetchImpl || fetch)(spec, { redirect: 'follow', signal: AbortSignal.timeout(15000), ...init });
  const refuse = (why) => fail(`--attach ${shownUrl(spec)}: can't tell its file type (${why}); supported: ${SUPPORTED}`);
  let res;
  try {
    res = await ask({ method: 'HEAD' });
    // Some servers refuse HEAD; the first byte of a GET carries the same header.
    if (res.status === 403 || res.status === 405) {
      res = await ask({ method: 'GET', headers: { Range: 'bytes=0-0' } });
      if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
    }
  } catch (err) {
    throw refuse(`could not reach it: ${redactText(err.message, [], [spec])}`);
  }
  const mime = String((res.headers && res.headers.get('content-type')) || '').split(';')[0].trim().toLowerCase();
  const type = TYPE_BY_MIME[mime];
  if (!res.ok) throw refuse(`HTTP ${res.status}`);
  if (!type) throw refuse(`the server says ${mime || 'nothing'}`);
  return [type, mime];
}

function unsupported(spec) {
  const ext = path.extname(spec).toLowerCase();
  const hint = EXPORT_AS[ext] ? `; export it as ${EXPORT_AS[ext]} first` : '';
  return fail(`--attach ${spec}: unsupported file type '${ext || '(none)'}'${hint}; supported: ${SUPPORTED}`);
}

// Resolves every --attach into an entry, in order, without reading any file
// content: {source, type, mime_type, via: 'url'|'inline'|'upload', bytes?, path?}.
// Local files go inline, in order, while the running base64 total stays under
// the request limit (the PDF limit once a PDF is in it). The first file that
// would cross it, and every local file after it, is uploaded instead. A file
// or URL given twice is attached once.
async function planAttachments(specs, fetchImpl) {
  const files = [];
  const seen = new Set();
  let inlineTotal = 0;
  let pdfInline = false;
  let spilled = false;
  for (const spec of specs) {
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(spec);
    const resolved = isUrl ? spec : path.resolve(spec);
    const key = !isUrl && process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    if (/^https:\/\//i.test(spec)) {
      const url = urlOrNull(spec);
      if (!url) throw fail(`--attach ${shownUrl(spec)}: not a URL`);
      const [type, mime] = typeFromExt(url.pathname) || (await sniffUrl(spec, fetchImpl));
      files.push({ source: spec, type, mime_type: mime, via: 'url' });
      continue;
    }
    if (isUrl) throw fail(`--attach ${shownUrl(spec)}: only local files and https URLs are supported`);
    let st;
    try {
      st = fs.statSync(spec);
    } catch (_) {
      throw fail(`--attach ${spec}: no such file`);
    }
    if (!st.isFile()) throw fail(`--attach ${spec}: not a file`);
    if (!st.size) throw fail(`--attach ${spec}: the file is empty`);
    const known = typeFromExt(spec);
    if (!known) throw unsupported(spec);
    const [type, mime] = known;
    if (st.size > UPLOAD_LIMIT) throw fail(`--attach ${spec}: ${size(st.size)} is over the Files API's 2 GB per-file limit`);
    const encoded = 4 * Math.ceil(st.size / 3);
    const isPdf = mime === 'application/pdf';
    const limit = pdfInline || isPdf ? PDF_INLINE_LIMIT : INLINE_LIMIT;
    const inline = !spilled && inlineTotal + encoded <= limit - INLINE_HEADROOM;
    if (inline) {
      inlineTotal += encoded;
      pdfInline = pdfInline || isPdf;
    } else {
      spilled = true;
    }
    files.push({ source: spec, path: resolved, type, mime_type: mime, via: inline ? 'inline' : 'upload', bytes: st.size });
  }
  return files;
}

// Turns the planned attachments into request content blocks, reading inline
// files and uploading the rest through `upload(path, mime) -> {uri, expiresAt}`.
// Returns the blocks for the request and the record kept in the store (no file
// bytes, and URLs masked).
async function materialize(files, upload, onUpload) {
  const items = [];
  const record = [];
  for (const a of files) {
    const rec = { source: a.via === 'url' ? shownUrl(a.source) : a.source, type: a.type, mime_type: a.mime_type, via: a.via };
    if (a.bytes != null) rec.bytes = a.bytes;
    // The inline budget was worked out from the size at planning time.
    const changed = () => fail(`--attach ${a.source}: the file changed after it was checked; run again`);
    if (a.via === 'url') {
      items.push({ type: a.type, uri: a.source, mime_type: a.mime_type });
    } else if (a.via === 'inline') {
      let buf;
      try {
        buf = fs.readFileSync(a.path);
      } catch (err) {
        throw fail(`--attach ${a.source}: could not read it (${err.message})`);
      }
      if (buf.length !== a.bytes) throw changed();
      items.push({ type: a.type, data: buf.toString('base64'), mime_type: a.mime_type });
    } else {
      const now = fs.statSync(a.path, { throwIfNoEntry: false });
      if (!now || now.size !== a.bytes) throw changed();
      if (onUpload) onUpload(a);
      const f = await upload(a.path, a.mime_type);
      rec.uri = f.uri;
      rec.expires_at = f.expiresAt || Date.now() + UPLOAD_TTL_MS;
      items.push({ type: a.type, uri: f.uri, mime_type: a.mime_type });
    }
    record.push(rec);
  }
  return { items, record };
}

// A batch sends the same attachments with every prompt, and inline bytes would
// go over the wire once per prompt, so there every local file is uploaded once.
function uploadAll(files) {
  return files.map((a) => (a.via === 'inline' ? { ...a, via: 'upload' } : a));
}

// --- resolve --------------------------------------------------------------

// All four MCP parsers return the shared state, so it lands under whichever of
// them appeared on the command line.
function mcpState(opts) {
  return opts.mcp || opts.mcpName || opts.mcpHeader || opts.mcpAllow || null;
}

// Every source flag, in the order the one-line "needs --agent" error names them.
function givenFlags(opts) {
  const st = mcpState(opts);
  const flags = [];
  if (st && st.servers.length) flags.push('--mcp');
  if (st && st.orphan) flags.push(st.orphan);
  if (opts.fileSearch && opts.fileSearch.length) flags.push('--file-search');
  if (opts.web === false) flags.push('--no-web');
  if (opts.attach && opts.attach.length) flags.push('--attach');
  if (opts.visualize) flags.push('--visualize');
  return flags;
}

function mcpWarnings(tools) {
  const warnings = [];
  for (const t of tools || []) {
    if (t.type !== 'mcp_server') continue;
    const shown = `--mcp ${shownUrl(t.url)}`;
    if (unreachableFromGoogle(t.url)) warnings.push(`${shown}: Google's servers make this call, so a local address will not be reachable`);
    if (/^http:/i.test(t.url) && (t.headers || urlSecrets(t.url).length)) {
      warnings.push(`${shown}: plain http, so its credentials cross the network unencrypted`);
    }
  }
  return warnings;
}

// Validates the source flags against each other and returns what the request
// needs: {tools, files, visualization, warnings}. Called before the spend guard,
// so a bad flag costs nothing and writes nothing.
async function resolve(opts, agent, fetchImpl) {
  const flags = givenFlags(opts);
  if (!flags.length) return { tools: undefined, files: [], visualization: undefined, warnings: [] };
  if (!agent) {
    throw fail(`${flags[0]} needs --agent: tools, attachments and visualization are Deep Research agent features (try --agent deep-research)`);
  }
  const st = mcpState(opts) || { servers: [], orphan: null };
  if (st.orphan) throw fail(`${st.orphan} applies to the --mcp before it, and there is none`);
  const stores = opts.fileSearch || [];
  const specs = opts.attach || [];
  if (opts.web === false && !st.servers.length && !stores.length && !specs.length) {
    throw fail('--no-web leaves the agent nothing to read: add --mcp, --file-search or --attach');
  }
  const tools = buildTools(st.servers, stores, opts.web);
  withEnv(tools);
  const files = await planAttachments(specs, fetchImpl);
  return { tools, files, visualization: opts.visualize ? 'auto' : undefined, warnings: mcpWarnings(tools) };
}

// --- describing -----------------------------------------------------------

function size(bytes) {
  return bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function describeTool(t) {
  if (t.type === 'mcp_server') {
    const hs = t.headers ? ` (${Object.keys(t.headers).map((k) => `${k}: ${MASK}`).join(', ')})` : '';
    const allow = t.allowed_tools ? ` [${t.allowed_tools.flatMap((a) => a.tools || []).join(', ')}]` : '';
    return `MCP ${t.name} ${shownUrl(t.url)}${hs}${allow}`;
  }
  if (t.type === 'file_search') return `File Search ${t.file_search_store_names.join(', ')}`;
  return t.type;
}

function describeAttachment(a) {
  return a.via === 'url' ? `${shownUrl(a.source)} (url)` : `${a.source} (${a.via}, ${size(a.bytes)})`;
}

// `src` below is what resolve() returns, or the same shape rebuilt from a
// stored row for a later turn (tools and visualization, no files).

// Lines for the spend confirmation and --dry-run. Header values never appear.
function describe(src) {
  const lines = [];
  if (src.tools) lines.push(`Tools: ${src.tools.map(describeTool).join('; ')}`);
  if (src.files.length) lines.push(`Attachments: ${src.files.map(describeAttachment).join('; ')}`);
  if (src.visualization) lines.push('Visualization: auto (charts are saved as image files)');
  return lines;
}

// The same, as extra keys for a --dry-run --json payload. Empty for a run with
// no sources.
function preview(src) {
  const fields = {};
  if (src.tools) fields.tools = redactTools(src.tools);
  if (src.files.length) {
    fields.attachments = src.files.map(({ path: _local, ...a }) => (a.via === 'url' ? { ...a, source: shownUrl(a.source) } : a));
  }
  if (src.visualization) fields.visualization = src.visualization;
  return fields;
}

module.exports = {
  INLINE_LIMIT,
  PDF_INLINE_LIMIT,
  INLINE_HEADROOM,
  mcpOptionParsers,
  buildTools,
  withEnv,
  planAttachments,
  materialize,
  uploadAll,
  resolve,
  redactTools,
  redactToolsJson,
  redactText,
  shownUrl,
  unreachableFromGoogle,
  describe,
  preview,
  size,
};
