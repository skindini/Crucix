// lib/source-health.mjs — payload-based source states, history trim, uptime math
// Uses Node.js built-in test runner (node:test) — no extra dependencies, no network

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifySource, hasData, readHistory, recordSweep, snapshotSweep, summarize,
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
    ['KiwiSDR active', OK, { status: 'active', network: { receivers: 612 } }, 'lit'],
    ['YFinance has no status field', OK, { quotes: { SPY: { price: 580.1 } } }, 'lit'],
    ['GDELT timed out (no payload)', { status: 'error', ms: 30002 }, undefined, 'error'],
    ['missing payload, timing ok', OK, undefined, 'error'],
    // refuted 2026-10-18 by adversarial-verify — each from a real payload shape
    ['HTML error page (JSON "token" text) is an outage, not a key', OK,
      { error: "Unexpected token '<', \"<!DOCTYPE html>\" is not valid JSON" }, 'error'],
    ['ReliefWeb rwError with no datasets', OK,
      { rwError: 'HTTP 406: Blocked due to bot activity', rwNote: 'retry later', hdxDatasets: [] }, 'error'],
    ['Bluesky topics all empty', OK, { topics: { conflict: [], markets: [], health: [] } }, 'empty'],
    ['OpenSanctions echoes each query with 0 results', OK,
      { recentSearches: [{ query: 'Russia', totalResults: 0, entities: [] }], totalSanctionedEntities: 0,
        datasets: [], monitoringTargets: ['Iran'] }, 'empty'],
    ['EPA zero readings beside static reference tables', OK,
      { totalReadings: 0, readings: [], monitoredAnalytes: ['I-131'], thresholds: { x: 1 }, note: 'n' }, 'empty'],
    ['status ok with an empty container', OK, { status: 'ok', items: [] }, 'empty'],
    // refuted in round 2 (2026-10-18)
    ['429 that mentions "API key" is an outage, not a missing key', OK,
      { error: 'HTTP 429: API key rate limit exceeded' }, 'error'],
    ['an error carried as an object', OK, { error: { message: 'boom' } }, 'error'],
    ['status "failed"', OK, { status: 'failed' }, 'error'],
    ['a non-empty errors list with no data', OK, { errors: ['fetch failed'], items: [] }, 'error'],
    ['a null *Error beside empty data is empty, not error', OK,
      { diseaseOutbreakNews: [], outbreakError: null, monitoringCapabilities: ['x'] }, 'empty'],
    ['a named *Error beside real data stays lit', OK,
      { diseaseOutbreakNews: [{ title: 'x' }], outbreakError: 'one feed down' }, 'lit'],
  ];
  for (const [label, timing, payload, want] of cases) {
    it(label, () => assert.equal(classifySource(timing, payload).state, want));
  }

  it('Telegram is judged by its posts, not its static channel list', () => {
    const dead = { status: 'web_scrape', channelsMonitored: 3, channelsReachable: 0, totalPosts: 0,
      topPosts: [], urgentPosts: [], channels: [{ title: 'a', reachable: false }],
      errors: [{ channel: 'a', error: 'HTTP 403' }] };
    assert.equal(classifySource(OK, dead, null, 'Telegram').state, 'error');
    const quiet = { ...dead, errors: undefined };
    assert.equal(classifySource(OK, quiet, null, 'Telegram').state, 'empty');
    assert.equal(classifySource(OK, { ...quiet, topPosts: [{ text: 'x' }] }, null, 'Telegram').state, 'lit');
  });

  it('a partial error rides along in the lit detail', () => {
    const c = classifySource(OK, { diseaseOutbreakNews: [1], outbreakError: 'one feed down' });
    assert.equal(c.detail, 'partial: one feed down');
  });

  it('hasData: zeros, empties and nested metadata carry nothing', () => {
    assert.equal(hasData({ a: 0, b: [], c: {}, d: '' }), false);
    assert.equal(hasData({ hits: [{ query: 'Iran', totalResults: 0 }] }), false);
    assert.equal(hasData({ value: 101.9 }), true);
  });

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

  it('drops the `undefined` row briefing.mjs writes for a rejected source', () => {
    const snap = snapshotSweep({ timing: { undefined: { status: 'error' }, FRED: OK },
      sources: { FRED: { indicators: [1] } } }, '2026-10-19T00:00:00.000Z');
    assert.deepEqual(Object.keys(snap.sources), ['FRED']);
  });
});

describe('recordSweep + readHistory', () => {
  it('appends, trims rows past 30 days, skips a torn line, an unparseable ts and a row without sources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-'));
    try {
      const path = join(dir, 'h.jsonl');
      const now = Date.parse('2026-10-19T00:00:00Z');
      const old = { ts: '2026-09-01T00:00:00Z', sources: { A: { state: 'lit' } } };
      writeFileSync(path, JSON.stringify(old) + '\n{"torn":\n'
        + JSON.stringify({ ts: 'not-a-date', sources: {} }) + '\n'
        + JSON.stringify({ ts: '2026-10-18T00:00:00Z' }) + '\n');
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
    assert.deepEqual(s.counts, { lit: 2, empty: 0, nokey: 0, stub: 0, error: 0 });
  });

  it('the 24h window is half-open: a sweep exactly 24h old is out', () => {
    const edge = summarize([{ ts: at(24), sources: { A: { state: 'lit' } } },
      { ts: at(0), sources: { A: { state: 'lit' } } }], { now });
    assert.equal(edge.cadence.sweeps_24h, 1);
    assert.equal(edge.sources[0].uptime_24h.sweeps, 1);
  });

  it('an empty history is an empty, well-formed answer', () => {
    const e = summarize([], { now });
    assert.deepEqual(e.sources, []);
    assert.equal(e.cadence.last_sweep, null);
  });
});
