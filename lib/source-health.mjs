// Per-source health history (fork-only, 2026-10-18).
//
// /api/health's sourcesOk counts a source as ok when it merely answered, so eight
// keyless sources looked healthy for months. This module judges each source by its
// PAYLOAD, appends one line per sweep to runs/source-health.jsonl, and summarises
// the history for GET /api/sources (MIDAS's "Data feeds" panel reads it).
//
// States:
//   lit    fetched, and the payload carries data
//   nokey  the source is missing its API key / credentials
//   stub   connected label, no data (Maritime "limited", AIS "ready")
//   empty  fetched with no error, but every data-bearing field is empty: a quiet
//          stretch, OR a module that swallowed its upstream failure (2026-10-18:
//          opensanctions.mjs turns "No API key provided" into zero results, bluesky.mjs
//          turns HTTP 403 into empty topics). The classifier can only judge what a
//          module passes through; uptime does not count empty.
//   error  threw, timed out, or reported a fetch error (including a named
//          `*Error` field, e.g. ReliefWeb's rwError, with no data behind it)

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';

export const HISTORY_FILE = 'source-health.jsonl';
export const RETENTION_DAYS = 30;
export const EXPECTED_SWEEPS_PER_DAY = (minutes) => Math.round((24 * 60) / minutes);

const NOKEY_STATUS = new Set(['no_key', 'no_credentials']);
const STUB_STATUS = new Set(['limited', 'ready']);
// Missing-or-rejected-key wording: the text names a key AND says it is missing or
// invalid, AND it is not a rate limit. Either way the remedy is the same: a valid key. Never "token" (Node's JSON parse error says "Unexpected token '<'"),
// and never a 429 that merely mentions the key ("no more requests for this API key").
const KEY_WORD = /api[ _-]?key|_KEY\b|map[ _-]?key|credentials|\bno key\b|register free/i;
// "no" counts only right before the key ("No FRED API key", "No FIRMS_MAP_KEY", "No
// api_key was supplied") — never a bare "no" elsewhere ("no route to host").
const MISSING_WORD = new RegExp([
  '\\bno\\s+(\\w+\\s+){0,2}(api[ _-]?key|key|credentials|[A-Z0-9]+_[A-Z0-9_]*KEY)\\b',
  '\\b(missing|not (set|configured|provided|supplied)|required|unset|invalid)\\b',
  'register free', '\\bset [A-Z0-9_]*KEY\\b', '_MISSING\\b',
].join('|'), 'i');
const RATE_WORD = /\b429\b|rate[ -]?limit|quota|too many|requests? (per|for)\b|no more requests/i;
export const isNoKeyText = (t) => KEY_WORD.test(t) && MISSING_WORD.test(t) && !RATE_WORD.test(t);
const ERROR_STATUS = new Set(['error', 'failed', 'failure']);

// Sources whose payload mixes static descriptors (channel lists, reference tables,
// monitored counts) with live data: judged only by the fields that carry this sweep's
// data. Everyone else is judged by every non-metadata field.
export const DATA_FIELDS = {
  Telegram: ['topPosts', 'urgentPosts'],
  'ADS-B': ['militaryAircraft'],
  // usaspending.mjs attaches its locally computed defenseWindow even when the search fails
  USAspending: ['recentDefenseContracts', 'topAgencies'],
};

// Fields that describe the source rather than carry this sweep's data: labels, notes,
// static reference tables, and the derived `signals` list. Checked against today's 29
// payloads (2026-10-18); a new source whose data lives under such a name reads `empty`.
const META_KEY = new RegExp([
  '^(source|timestamp|status|message|hint|note|method|error|errors|signals|trend|searchWindow|query)$',
  '^(lastUpdated|catalogVersion|dateReleased|endpoints|integrationGuide|complementarySource)$',
  'Error$', 'Note$', 'Basis', 'Capabilities$', '^known', '^covered', '^monitor', '^thresholds$',
  '^domains$',
].join('|'));

// Does this value carry anything? Zero counts and empty containers do not, and neither
// does a metadata field at any depth (OpenSanctions echoes each `query` with 0 results).
export function hasData(v) {
  if (v == null || v === '' || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return true;
  if (typeof v === 'boolean') return false; // a flag (OFAC's dataAvailable) is not data
  if (Array.isArray(v)) return v.some(hasData);
  if (typeof v === 'object') return Object.entries(v).some(([k, x]) => !META_KEY.test(k) && hasData(x));
  return false;
}

function dataFields(payload, name) {
  const only = DATA_FIELDS[name];
  if (only) return only.map((k) => payload[k]);
  return Object.entries(payload).filter(([k]) => !META_KEY.test(k)).map(([, v]) => v);
}

const errText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
// An error field counts when present at all — its own keys (`message`) are not data.
const errPresent = (v) => (typeof v === 'string' ? v.length > 0
  : v != null && typeof v === 'object' && Object.keys(v).length > 0);

// An error the payload names without the top-level `error` key: a `*Error` field
// (ReliefWeb's rwError) or a non-empty `errors` list (Telegram's per-channel 403s).
function namedError(payload) {
  for (const [k, v] of Object.entries(payload)) {
    if (k !== 'error' && /Error$/.test(k) && errPresent(v)) return errText(v);
  }
  if (Array.isArray(payload.errors) && payload.errors.length) return errText(payload.errors[0]);
  return null;
}

// One source's state from its timing row (did the fetch complete?) and payload.
export function classifySource(timing, payload, errorText, name) {
  if (timing && timing.status && timing.status !== 'ok') {
    return { state: 'error', detail: errorText || timing.status };
  }
  if (!payload || typeof payload !== 'object') {
    return { state: 'error', detail: errorText || 'no payload' };
  }
  const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : null;
  if (status && NOKEY_STATUS.has(status)) return { state: 'nokey', detail: status };
  if (errPresent(payload.error)) {
    const e = errText(payload.error);
    return isNoKeyText(e) ? { state: 'nokey', detail: e } : { state: 'error', detail: e };
  }
  if (status && ERROR_STATUS.has(status)) return { state: 'error', detail: status };
  if (status && STUB_STATUS.has(status)) return { state: 'stub', detail: status };
  const carries = dataFields(payload, name).some(hasData);
  const partial = namedError(payload);
  if (!carries) {
    return partial ? { state: 'error', detail: partial } : { state: 'empty', detail: 'fetched, no data' };
  }
  return { state: 'lit', detail: partial ? `partial: ${partial}` : (status || 'ok') };
}

// The whole sweep → {ts, sources: {name: {state, ms, detail}}}. timing is the
// authoritative source list (it includes a source that timed out before it could
// write a payload, e.g. GDELT).
export function snapshotSweep(rawData, ts) {
  const timing = rawData?.timing || {};
  const payloads = rawData?.sources || {};
  const errors = new Map((rawData?.errors || []).map((e) => [e.name, e.error]));
  const names = new Set([...Object.keys(timing), ...Object.keys(payloads)]);
  names.delete('undefined'); // briefing.mjs names a rejected source's row `undefined`
  const sources = {};
  for (const name of [...names].sort()) {
    const t = timing[name];
    const c = classifySource(t, payloads[name], errors.get(name), name);
    sources[name] = { state: c.state, ms: t?.ms ?? null, detail: String(c.detail).slice(0, 160) };
  }
  return { ts: ts || rawData?.crucix?.timestamp || new Date().toISOString(), sources };
}

export function readHistory(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; } // a torn line is skipped, never fatal
    // an unparseable ts would count in every window; a row without sources would crash summarize
    if (row && Number.isFinite(Date.parse(row.ts)) && row.sources && typeof row.sources === 'object') out.push(row);
  }
  return out;
}

// Append one sweep; rewrite the file without lines older than the retention window
// only when the oldest line has aged out (so the common path is a single append).
export function recordSweep(path, snapshot, now = Date.now()) {
  appendFileSync(path, JSON.stringify(snapshot) + '\n');
  const cutoff = now - RETENTION_DAYS * 86400e3;
  const rows = readHistory(path);
  if (rows.length && Date.parse(rows[0].ts) < cutoff) {
    const kept = rows.filter((r) => Date.parse(r.ts) >= cutoff);
    writeFileSync(path, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
  }
}

function uptime(rows, name, sinceMs) {
  let seen = 0;
  let lit = 0;
  for (const r of rows) {
    if (Date.parse(r.ts) <= sinceMs) continue; // half-open window: 96 sweeps per 24h, not 97
    const s = r.sources?.[name];
    if (!s) continue;
    seen++;
    if (s.state === 'lit') lit++;
  }
  return seen ? { pct: Math.round((lit / seen) * 1000) / 10, lit, sweeps: seen } : null;
}

// The /api/sources body: sweep cadence + one row per source in the latest sweep.
export function summarize(rows, { now = Date.now(), refreshMinutes = 15 } = {}) {
  const day = now - 86400e3;
  const week = now - 7 * 86400e3;
  const latest = rows[rows.length - 1] || null;
  const lastLit = {};
  for (const r of rows) {
    for (const [name, s] of Object.entries(r.sources || {})) {
      if (s.state === 'lit') lastLit[name] = r.ts;
    }
  }
  const sources = latest
    ? Object.entries(latest.sources).map(([name, s]) => ({
      name,
      state: s.state,
      detail: s.detail,
      ms: s.ms,
      last_lit: lastLit[name] || null,
      uptime_24h: uptime(rows, name, day),
      uptime_7d: uptime(rows, name, week),
    }))
    : [];
  const counts = { lit: 0, empty: 0, nokey: 0, stub: 0, error: 0 };
  for (const s of sources) counts[s.state] = (counts[s.state] || 0) + 1;
  return {
    generated_at: new Date(now).toISOString(),
    cadence: {
      last_sweep: latest?.ts || null,
      sweeps_24h: rows.filter((r) => Date.parse(r.ts) > day).length,
      expected_24h: EXPECTED_SWEEPS_PER_DAY(refreshMinutes),
      history_since: rows[0]?.ts || null,
    },
    counts,
    sources,
  };
}
