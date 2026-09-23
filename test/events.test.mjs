// /api/events payload + first_seen memory
// Uses Node.js built-in test runner (node:test) — no extra dependencies, no network

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIdeaEvents, ideaId, ideaSource } from '../lib/events.mjs';
import { MemoryManager } from '../lib/delta/memory.mjs';
import { generateIdeas } from '../dashboard/inject.mjs';

const TS = '2026-09-23T12:00:00.000Z';

const llmIdea = {
  title: 'Energy bid', type: 'LONG', ticker: 'XLE', confidence: 'MEDIUM',
  rationale: 'WTI up 4% on Hormuz chatter', risk: 'Demand shock', horizon: 'Weeks',
  signals: ['WTI', 'Brent'], source: 'llm',
};
const rulesIdea = {
  title: 'Elevated Volatility Regime', text: 'VIX at 25 — fear premium elevated.',
  type: 'hedge', confidence: 'High', horizon: 'tactical', source: 'rules',
};

// The pre-change formula from server.mjs, verbatim — MIDAS dedupes on this id.
const legacyId = (i) => createHash('sha1').update(`${i.type}:${i.ticker || ''}:${i.title}`).digest('hex').slice(0, 12);

describe('buildIdeaEvents', () => {
  it('keeps every original field and shape', () => {
    const [ev] = buildIdeaEvents([llmIdea], { ts: TS, ideasSource: 'llm' });
    assert.equal(ev.ts, TS);
    assert.equal(ev.kind, 'idea_long');
    assert.equal(ev.payload.id, legacyId(llmIdea));
    assert.equal(ev.payload.ticker, 'XLE');
    assert.equal(ev.payload.title, 'Energy bid');
    assert.equal(ev.payload.confidence, 'MEDIUM');
    assert.equal(ev.payload.horizon, 'Weeks');
    assert.equal(ev.payload.rationale, 'WTI up 4% on Hormuz chatter');
  });

  it('adds source, risk, signals and first_seen', () => {
    const [ev] = buildIdeaEvents([{ ...llmIdea, first_seen: '2026-09-23T09:00:00.000Z' }], { ts: TS, ideasSource: 'llm' });
    assert.equal(ev.payload.source, 'llm');
    assert.equal(ev.payload.risk, 'Demand shock');
    assert.deepEqual(ev.payload.signals, ['WTI', 'Brent']);
    assert.equal(ev.payload.first_seen, '2026-09-23T09:00:00.000Z');
  });

  it('rules ideas: source=rules, rationale from text, no ticker, first_seen falls back to ts', () => {
    const [ev] = buildIdeaEvents([rulesIdea], { ts: TS, ideasSource: 'llm-failed:timeout→rules' });
    assert.equal(ev.kind, 'idea_hedge');
    assert.equal(ev.payload.source, 'rules');
    assert.equal(ev.payload.rationale, 'VIX at 25 — fear premium elevated.');
    assert.equal(ev.payload.risk, null);
    assert.deepEqual(ev.payload.signals, []);
    assert.equal(ev.payload.first_seen, TS);
    assert.equal(ev.payload.id, legacyId(rulesIdea));
    // JSON on the wire omits an undefined ticker, exactly as before
    assert.ok(!('ticker' in JSON.parse(JSON.stringify(ev.payload))));
  });

  it('ideaSource falls back to the sweep ideasSource for untagged ideas', () => {
    assert.equal(ideaSource({}, 'llm'), 'llm');
    assert.equal(ideaSource({}, 'llm-failed→rules'), 'rules');
    assert.equal(ideaSource({}, 'rules'), 'rules');
    assert.equal(ideaSource({}, undefined), 'rules');
    assert.equal(ideaSource({ source: 'llm' }, 'rules'), 'llm');
  });

  it('the rules engine tags its ideas source=rules', () => {
    const V2 = {
      fred: [{ id: 'VIXCLS', value: 26 }], tg: { urgent: [] },
      energy: { wti: 60, wtiRecent: [] }, treasury: { totalDebt: '0' },
      thermal: [], bls: [], acled: {}, gscpi: null,
    };
    const ideas = generateIdeas(V2);
    assert.ok(ideas.length > 0);
    assert.ok(ideas.every(i => i.source === 'rules'));
    assert.ok(buildIdeaEvents(ideas, { ts: TS, ideasSource: 'rules' }).every(e => e.payload.source === 'rules'));
  });

  it('is parseable by the MIDAS mapping (events envelope, kind, ISO ts, dict payload)', () => {
    // Mirrors midas src/midas/events.py HttpEventSource.parse_feed/_to_event.
    const wire = JSON.parse(JSON.stringify({ events: buildIdeaEvents([llmIdea, rulesIdea], { ts: TS, ideasSource: 'llm' }) }));
    for (const item of wire.events) {
      assert.ok(item.kind);
      assert.ok(!Number.isNaN(Date.parse(item.ts)));
      assert.equal(typeof item.payload, 'object');
      assert.ok(typeof item.payload.id === 'string' && item.payload.id.length === 12);
    }
  });
});

describe('MemoryManager.stampFirstSeen', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'crucix-firstseen-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const minimalRun = (ideas) => ({ meta: { timestamp: TS }, ideas, tg: { urgent: [] }, thermal: [], air: [], nuke: [], who: [] });

  it('stamps first_seen on first sight and keeps it on re-serve, across restarts', () => {
    const m1 = new MemoryManager(dir);
    const a = [{ ...llmIdea }];
    m1.stampFirstSeen(a, '2026-09-23T10:00:00.000Z');
    assert.equal(a[0].first_seen, '2026-09-23T10:00:00.000Z');
    m1.addRun(minimalRun(a), {}); // persists hot.json

    const m2 = new MemoryManager(dir); // simulated restart
    const b = [{ ...llmIdea }, { ...llmIdea, title: 'Something new' }];
    m2.stampFirstSeen(b, '2026-09-23T10:15:00.000Z');
    assert.equal(b[0].first_seen, '2026-09-23T10:00:00.000Z');
    assert.equal(b[1].first_seen, '2026-09-23T10:15:00.000Z');
    assert.equal(m2.hot.ideaFirstSeen[ideaId(llmIdea)].last, '2026-09-23T10:15:00.000Z');
  });

  it('archives the new wire fields with the run', () => {
    const m = new MemoryManager(dir);
    const ideas = [{ ...llmIdea }];
    m.stampFirstSeen(ideas, '2026-09-23T10:30:00.000Z');
    m.addRun(minimalRun(ideas), {});
    const archived = m.getLastRun().ideas[0];
    assert.equal(archived.source, 'llm');
    assert.equal(archived.risk, 'Demand shock');
    assert.deepEqual(archived.signals, ['WTI', 'Brent']);
    assert.equal(archived.first_seen, '2026-09-23T10:00:00.000Z');
  });

  it('forgets ids not seen for 7 days', () => {
    const m = new MemoryManager(dir);
    const late = [{ ...rulesIdea }];
    m.stampFirstSeen(late, '2026-10-05T00:00:00.000Z');
    assert.equal(m.hot.ideaFirstSeen[ideaId(llmIdea)], undefined);
    assert.equal(late[0].first_seen, '2026-10-05T00:00:00.000Z');
  });
});
