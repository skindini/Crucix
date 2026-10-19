// lib/raw-archive.mjs — one gzip member per sweep, readable as a day of JSONL
// Uses Node.js built-in test runner (node:test) — no extra dependencies, no network

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { archivePath, archiveSweep, rawLine } from '../lib/raw-archive.mjs';

const SWEEP = {
  timing: { FRED: { status: 'ok', ms: 900 }, Telegram: { status: 'ok', ms: 10 } },
  errors: [],
  sources: {
    FRED: { indicators: [{ id: 'DFF', value: 3.88 }] },
    'Cloudflare-Radar': { outages: { total: 5 } },
    Telegram: { topPosts: [{ text: 'long post body' }] },
    undefined: { error: 'rejected' },
  },
};

describe('raw archive', () => {
  it('keeps every source but the excluded ones and the `undefined` row', () => {
    const line = rawLine(SWEEP, '2026-10-19T03:34:31.113Z');
    assert.deepEqual(Object.keys(line.sources).sort(), ['Cloudflare-Radar', 'FRED']);
    assert.equal(line.timing.FRED.ms, 900);
  });

  it('appends one gzip member per sweep; the day reads back as JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raw-'));
    try {
      const a = archiveSweep(dir, SWEEP, '2026-10-19T03:34:31.113Z');
      const b = archiveSweep(dir, SWEEP, '2026-10-19T03:49:31.113Z');
      assert.equal(a, b);
      const rows = gunzipSync(readFileSync(a)).toString().trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(rows.map((r) => r.ts), ['2026-10-19T03:34:31.113Z', '2026-10-19T03:49:31.113Z']);
      assert.equal(rows[1].sources.FRED.indicators[0].value, 3.88);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('files by the sweep\'s UTC date and refuses an unparseable ts', () => {
    assert.ok(archivePath('/r', '2026-10-20T00:05:00Z').endsWith('raw/2026-10-20.jsonl.gz'));
    assert.throws(() => archiveSweep('/nonexistent', SWEEP, 'not-a-date'), /unparseable/);
  });
});
