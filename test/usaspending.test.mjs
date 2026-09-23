// USAspending — ranking by in-window obligations, not lifetime award value
// Uses Node.js built-in test runner (node:test) — no extra dependencies, no network

import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  briefing,
  summarizeObligations,
  AMOUNT_BASIS,
} from '../apis/sources/usaspending.mjs';
import { synthesizeDefense } from '../dashboard/inject.mjs';
import { formatDefenseForLLM } from '../lib/llm/ideas.mjs';

// Shaped like real search/spending_by_transaction rows (2026-09-23 window).
const TX = [
  {
    'Award ID': 'NNK17MA01T', Mod: '72', 'Recipient Name': 'SPACE EXPLORATION TECHNOLOGIES CORP.',
    'Action Date': '2026-09-18', 'Transaction Amount': 519393669.31,
    'Transaction Description': 'COMMERCIAL CREW PROGRAM', 'Awarding Agency': 'National Aeronautics and Space Administration',
    'Awarding Sub Agency': 'National Aeronautics and Space Administration', 'Award Type': 'DELIVERY ORDER',
    generated_internal_id: 'CONT_AWD_NNK17MA01T_8000_NNK14MA74C_8000',
  },
  {
    // The 2026-09-23 misread: a $22.65B LIFETIME contract (started 1993) whose
    // actual in-window action is a $210.6M funding mod.
    'Award ID': 'NAS1510000', Mod: '3246', 'Recipient Name': 'THE BOEING COMPANY',
    'Action Date': '2026-09-11', 'Transaction Amount': 210564973.85,
    'Transaction Description': 'INTERNATIONAL SPACE STATION', 'Awarding Agency': 'National Aeronautics and Space Administration',
    'Award Type': 'DEFINITIVE CONTRACT', generated_internal_id: 'CONT_AWD_NAS1510000_8000_-NONE-_-NONE-',
  },
  {
    'Award ID': '47QFCA26F0018', Mod: 'P00002', 'Recipient Name': 'BOOZ ALLEN HAMILTON INC',
    'Action Date': '2026-09-10', 'Transaction Amount': 90122792,
    'Transaction Description': 'INCREMENTAL FUNDING', 'Awarding Agency': 'General Services Administration',
    generated_internal_id: 'CONT_AWD_47QFCA26F0018_4732_47QTCK18D0004_4732',
  },
  {
    'Award ID': '47QFCA26F0018', Mod: 'P00003', 'Recipient Name': 'BOOZ ALLEN HAMILTON INC',
    'Action Date': '2026-09-14', 'Transaction Amount': 18034598,
    'Transaction Description': 'MORE FUNDING', 'Awarding Agency': 'General Services Administration',
    generated_internal_id: 'CONT_AWD_47QFCA26F0018_4732_47QTCK18D0004_4732',
  },
  {
    'Award ID': 'W912DQ26FA080', Mod: '0', 'Recipient Name': 'HDR-OBG A JOINT VENTURE',
    'Action Date': '2026-09-14', 'Transaction Amount': 300000,
    'Transaction Description': 'REMEDIAL DESIGN', 'Awarding Agency': 'Department of Defense',
    'Awarding Sub Agency': 'Department of the Army', generated_internal_id: 'CONT_AWD_W912DQ26FA080_9700',
  },
  {
    // A pure de-obligation nets below zero → dropped, never ranked as money in.
    'Award ID': 'DEOB1', Mod: 'P00009', 'Recipient Name': 'DEOBLIGATED CO',
    'Action Date': '2026-09-12', 'Transaction Amount': -5000000, generated_internal_id: 'CONT_AWD_DEOB1',
  },
];

describe('summarizeObligations', () => {
  it('ranks awards by money obligated inside the window', () => {
    const rows = summarizeObligations(TX);
    assert.deepEqual(rows.map(r => r.awardId), ['NNK17MA01T', 'NAS1510000', '47QFCA26F0018', 'W912DQ26FA080']);
  });

  it('labels every amount as an in-window obligation (never the lifetime total)', () => {
    const boeing = summarizeObligations(TX).find(r => r.awardId === 'NAS1510000');
    assert.equal(boeing.amount, 210564973.85);
    assert.equal(boeing.obligatedInWindow, 210564973.85);
    assert.equal(boeing.amountBasis, AMOUNT_BASIS);
    assert.equal(boeing.amountBasis, 'obligated_in_window');
    assert.equal(boeing.newAward, false);
    assert.equal(boeing.latestMod, '3246');
    assert.equal(boeing.agency, 'National Aeronautics and Space Administration');
  });

  it('sums multiple actions on one award and keeps the latest action date', () => {
    const booz = summarizeObligations(TX).find(r => r.awardId === '47QFCA26F0018');
    assert.equal(booz.obligatedInWindow, 108157390);
    assert.equal(booz.actions, 2);
    assert.equal(booz.date, '2026-09-14');
    assert.equal(booz.latestMod, 'P00003');
  });

  it('flags a base action (mod 0) as a new award', () => {
    const army = summarizeObligations(TX).find(r => r.awardId === 'W912DQ26FA080');
    assert.equal(army.newAward, true);
    assert.equal(army.agency, 'Department of Defense');
  });

  it('drops net de-obligations and malformed rows; honours limit', () => {
    const rows = summarizeObligations([...TX, { 'Award ID': 'X' }, null, { 'Transaction Amount': 1 }]);
    assert.ok(!rows.some(r => r.awardId === 'DEOB1'));
    assert.ok(!rows.some(r => r.awardId === 'X'));
    assert.equal(summarizeObligations(TX, { limit: 2 }).length, 2);
    assert.deepEqual(summarizeObligations(undefined), []);
  });
});

describe('USAspending briefing (mocked fetch)', () => {
  afterEach(() => mock.restoreAll());

  it('queries contract TRANSACTIONS sorted by Transaction Amount inside the window', async () => {
    const calls = [];
    mock.method(globalThis, 'fetch', async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      const payload = String(url).includes('spending_by_transaction')
        ? { results: TX }
        : { results: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const out = await briefing();
    const search = calls.find(c => c.url.includes('/search/'));
    assert.ok(search.url.endsWith('/search/spending_by_transaction/'), search.url);
    assert.equal(search.body.sort, 'Transaction Amount');
    assert.equal(search.body.order, 'desc');
    for (const f of ['Mod', 'Action Date', 'Transaction Amount', 'Awarding Agency']) {
      assert.ok(search.body.fields.includes(f), `missing field ${f}`);
    }
    assert.ok(!calls.some(c => c.url.includes('spending_by_award')), 'must not rank by cumulative Award Amount');

    assert.equal(out.defenseAmountBasis, 'obligated_in_window');
    assert.equal(out.defenseWindow.days, 14);
    assert.equal(out.recentDefenseContracts[1].awardId, 'NAS1510000');
    assert.equal(out.recentDefenseContracts[1].amount, 210564973.85);
    assert.equal(out.defenseError, undefined);
  });

  it('retries once when the search request throws, then succeeds', async () => {
    let searches = 0;
    mock.method(globalThis, 'fetch', async (url) => {
      if (String(url).includes('/search/')) {
        searches += 1;
        if (searches === 1) throw new Error('This operation was aborted');
        return new Response(JSON.stringify({ results: TX }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const out = await briefing();
    assert.equal(searches, 2);
    assert.equal(out.recentDefenseContracts.length, 4);
    assert.equal(out.defenseError, undefined);
  });

  it('reports the error after the second failed attempt', async () => {
    mock.method(globalThis, 'fetch', async (url) => {
      if (String(url).includes('/search/')) throw new Error('This operation was aborted');
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const out = await briefing();
    assert.deepEqual(out.recentDefenseContracts, []);
    assert.match(out.defenseError, /aborted \(after 2 attempts\)/);
  });

  it('degrades to an empty list with defenseError on HTTP failure', async () => {
    mock.method(globalThis, 'fetch', async (url) => String(url).includes('/search/')
      ? new Response('boom', { status: 500 })
      : new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const out = await briefing();
    assert.deepEqual(out.recentDefenseContracts, []);
    assert.match(out.defenseError, /HTTP 500/);
  });
});

describe('defense rows → LLM context', () => {
  it('reaches the LLM as new money with agency, mod status and date — never the $22.65B lifetime value', () => {
    const defense = synthesizeDefense({ recentDefenseContracts: summarizeObligations(TX) });
    const line = formatDefenseForLLM(defense);
    assert.match(line, /^FEDERAL_CONTRACT_OBLIGATIONS \(.*NOT total contract value/);
    assert.match(line, /\$211M newly obligated to THE BOEING COMPANY \(National Aeronautics and Space Administration; modification of an existing award; 2026-09-11\)/);
    assert.doesNotMatch(line, /22654|22\.65/);
    assert.doesNotMatch(line, /fresh/i);
  });

  it('labels a pre-fix row (no amountBasis) as a LIFETIME total, not new money', () => {
    // Shape of runs/latest.json written by the old award-level query.
    const legacy = synthesizeDefense({
      recentDefenseContracts: [{ recipient: 'THE BOEING COMPANY', amount: 22653518818.25, description: 'INTERNATIONAL SPACE STATION', agency: 'National Aeronautics and Space Administration', date: '1993-11-15' }],
    });
    assert.equal(legacy[0].basis, 'award_total');
    const line = formatDefenseForLLM(legacy);
    assert.match(line, /\$22654M TOTAL LIFETIME award value, NOT new money — THE BOEING COMPANY/);
    assert.doesNotMatch(line, /newly obligated/);
  });

  it('omits the section when there are no rows', () => {
    assert.equal(formatDefenseForLLM([]), null);
    assert.equal(formatDefenseForLLM(undefined), null);
  });
});
