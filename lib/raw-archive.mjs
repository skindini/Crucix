// Raw sweep archive (fork-only, 2026-10-19).
//
// The cold store (lib/delta/memory.mjs) keeps 14 synthesized blocks per sweep. Sources
// outside them (Cloudflare Radar, OFAC, OpenSanctions, USAspending, CISA-KEV, Comtrade,
// Patents, Space, NOAA, KiwiSDR, the YFinance market block, EIA's full payload) left no
// history at all, so no play could ever be backtested on them. This appends every
// sweep's raw per-source payloads to runs/raw/YYYY-MM-DD.jsonl.gz: one gzip member per
// sweep (multi-member gzip: zcat and Python's gzip read the whole day as JSONL).
//
// Kept indefinitely (~2 MB/day): the history is the point. Telegram is excluded by
// default: its post text is ~40% of a sweep and the cold store already keeps it ('tg').

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { gzipSync } from 'zlib';

export const RAW_DIR = 'raw';
export const DEFAULT_EXCLUDE = ['Telegram'];

export function rawLine(rawData, ts, exclude = DEFAULT_EXCLUDE) {
  const skip = new Set(exclude);
  const sources = {};
  for (const [name, payload] of Object.entries(rawData?.sources || {})) {
    if (!skip.has(name) && name !== 'undefined') sources[name] = payload;
  }
  return {
    ts,
    timing: rawData?.timing || {},
    errors: rawData?.errors || [],
    sources,
  };
}

// The archive day is the sweep's UTC date, so a file never mixes two days.
export function archivePath(runsDir, ts) {
  return join(runsDir, RAW_DIR, `${String(ts).slice(0, 10)}.jsonl.gz`);
}

export function archiveSweep(runsDir, rawData, ts, exclude = DEFAULT_EXCLUDE) {
  if (!Number.isFinite(Date.parse(ts))) throw new Error(`unparseable sweep ts: ${ts}`);
  mkdirSync(join(runsDir, RAW_DIR), { recursive: true });
  const path = archivePath(runsDir, ts);
  appendFileSync(path, gzipSync(JSON.stringify(rawLine(rawData, ts, exclude)) + '\n'));
  return path;
}
