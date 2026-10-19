// lib/source-health.mjs — payload-based source states, history trim, uptime math
// Uses Node.js built-in test runner (node:test) — no extra dependencies, no network

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifySource, readHistory, recordSweep, snapshotSweep, summarize,
} from '../lib/source-health.mjs';

const OK = { status: 'ok', ms: 100 };

describe('classifySource — the payload decides, not the label', () => {
  const cases = [
    ['FRED with data', OK, { source: 'FRED', indicators: [{ id: 'DFF' }] }, 'lit'],
    ['FRED keyless (error hint)', OK, { source: 'FRED', error: 'No FRED API key. Get one free at …' }, 'nokey'],
    ['ACLED no_credentials', OK, { source: 'ACLED', status: 'no_credentials' }, 'nokey'],
    ['Reddit no_key', OK, { source: 'Reddit', status: 'no_key' }, 'nokey'],
    ['Maritime limited', OK, { source: 'Maritime', status: 'limited', chokepoints: {} }, 'stub'],
    ['AIS ready (key set, no data)', OK, { source: 'Maritime', status: 'ready' }, 'stub'],
    ['Space fetch failed', OK, { source: 'Space', status: 'error', error: 'fetch failed' }, 'error'],
    ['Telegram web_scrape carries posts', OK, { status: 'web_scrape', totalPosts: 187 }, 'lit'],
    ['KiwiSDR active', OK, { status: 'active', network: {} }, 'lit'],
    ['YFinance has no status field', OK, { quotes: {} }, 'lit'],
    ['GDELT timed out (no payload)', { status: 'error', ms: 30002 }, undefined, 'error'],
    ['missing payload, timing ok', OK, undefined, 'error'],
  ];
  for (const [label, timing, payload, want] of cases) {
    it(label, () => assert.equal(classifySource(timing, payload).state, want));
  }

  it('a timeout carries the briefing error text as its detail', () => {
    const c = classifySource({ status: 'error' }, undefined, 'Source GDELT timed out after 30s');
    assert.equal(c.detail, 'Source GDELT timed out after 30s');
  });
});

describe('snapshotSweep', () => {
  it('lists a source that exists only in timing (timed out before writing a payload)', () => {
    const snap = snapshotSweep({
      timing: { GDELT: { status: 'error', ms: 30002 }, FRED: OK },
      sources: { FRED: { indicators: [1] } },
      errors: [{ name: 'GDELT', error: 'Source GDELT timed out after 30s' }],
    }, '2026-10-19T00:00:00.000Z');
    assert.deepEqual(Object.keys(snap.sources), ['FRED', 'GDELT']);
    assert.equal(snap.sources.GDELT.state, 'error');
    assert.equal(snap.sources.GDELT.ms, 30002);
    assert.equal(snap.sources.FRED.state, 'lit');
    assert.equal(snap.ts, '2026-10-19T00:00:00.000Z');
  });
});

describe('recordSweep + readHistory', () => {
  it('appends, trims rows past 30 days, and skips a torn line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-'));
    try {
      const path = join(dir, 'h.jsonl');
      const now = Date.parse('2026-10-19T00:00:00Z');
      const old = { ts: '2026-09-01T00:00:00Z', sources: { A: { state: 'lit' } } };
      writeFileSync(path, JSON.stringify(old) + '\n{"torn":\n');
      recordSweep(path, { ts: '2026-10-19T00:00:00Z', sources: { A: { state: 'nokey' } } }, now);
      const rows = readHistory(path);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].sources.A.state, 'nokey');
      assert.ok(!readFileSync(path, 'utf8').includes('2026-09-01'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('summarize', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const at = (h) => new Date(now - h * 3600e3).toISOString();
  const rows = [
    { ts: at(72), sources: { FRED: { state: 'lit' }, EIA: { state: 'nokey' } } },
    { ts: at(3), sources: { FRED: { state: 'nokey' }, EIA: { state: 'nokey' } } },
    { ts: at(2), sources: { FRED: { state: 'lit' }, EIA: { state: 'nokey' } } },
    { ts: at(1), sources: { FRED: { state: 'lit', ms: 900, detail: 'ok' }, EIA: { state: 'lit', ms: 50, detail: 'ok' } } },
  ];
  const s = summarize(rows, { now, refreshMinutes: 15 });
  const by = Object.fromEntries(s.sources.map((r) => [r.name, r]));

  it('uptime counts lit sweeps over sweeps in the window', () => {
    assert.deepEqual(by.FRED.uptime_24h, { pct: 66.7, lit: 2, sweeps: 3 });
    assert.deepEqual(by.FRED.uptime_7d, { pct: 75, lit: 3, sweeps: 4 });
    assert.deepEqual(by.EIA.uptime_24h, { pct: 33.3, lit: 1, sweeps: 3 });
  });

  it('last_lit is the newest lit sweep; current state is the latest sweep', () => {
    assert.equal(by.EIA.last_lit, at(1));
    assert.equal(by.FRED.state, 'lit');
    assert.equal(by.FRED.ms, 900);
  });

  it('cadence compares sweeps in 24h with the expected count', () => {
    assert.equal(s.cadence.sweeps_24h, 3);
    assert.equal(s.cadence.expected_24h, 96);
    assert.equal(s.cadence.last_sweep, at(1));
    assert.deepEqual(s.counts, { lit: 2, nokey: 0, stub: 0, error: 0 });
  });

  it('an empty history is an empty, well-formed answer', () => {
    const e = summarize([], { now });
    assert.deepEqual(e.sources, []);
    assert.equal(e.cadence.last_sweep, null);
  });
});
