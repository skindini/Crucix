// USAspending — Federal spending, defense contracts, procurement signals
// No auth required. Updated daily.
//
// READ THIS before touching the ranking: the award-level endpoint
// (search/spending_by_award) returns every award with ANY activity in the time
// window, and its "Award Amount" is the award's CUMULATIVE obligation since
// inception. Ranking by it surfaces decades-old mega-contracts that merely got a
// modification this week — on 2026-09-23 the LLM read Boeing's International
// Space Station contract (NAS1510000, started 1993, $22.65B lifetime) as a
// "fresh $22.65B defense award". The sweep therefore ranks by TRANSACTIONS
// (search/spending_by_transaction): each row is one contract action dated
// inside the window, and "Transaction Amount" is the money that action
// obligated. Rows are summed per award, so every amount here is NEW money
// obligated inside the window, never a lifetime total.
//
// Also: DoD contract actions are published to FPDS/USAspending with a ~90-day
// delay, so a 14-day "defense" keyword window is dominated by civilian agencies
// (NASA, GSA, DOE). Each row carries its awarding agency so nothing downstream
// has to guess.

import { safeFetch, daysAgo } from '../utils/fetch.mjs';

const BASE = 'https://api.usaspending.gov/api/v2';

// Award type codes — required by the spending_by_award endpoint
// Contracts: A=BPA Call, B=Purchase Order, C=Delivery Order, D=Definitive Contract
// Grants: 02=Block Grant, 03=Formula Grant, 04=Project Grant, 05=Cooperative Agreement
// Direct payments: 06=Direct Payment (unrestricted), 07=Direct Payment (specified use)
// Loans: 08=Direct Loan, 09=Guaranteed/Insured Loan
// IDVs: IDV_A=GWAC, IDV_B=IDC, IDV_B_A=IDC / IDV, IDV_B_B=IDC / Multiple Award,
//        IDV_B_C=IDC / FSS, IDV_C=FSS, IDV_D=BOA, IDV_E=BPA
const CONTRACT_CODES = ['A', 'B', 'C', 'D'];
const ALL_AWARD_CODES = ['A', 'B', 'C', 'D', '02', '03', '04', '05', '06', '07', '08', '09'];

const DEFENSE_KEYWORDS = ['defense', 'military', 'missile', 'ammunition', 'aircraft', 'naval'];
export const DEFENSE_WINDOW_DAYS = 14;

// What every `amount` in recentDefenseContracts means. Downstream code (the
// dashboard synthesizer, the LLM prompt compactor, /api/state) keys its labels
// off this string — an amount without a basis is treated as a lifetime total.
export const AMOUNT_BASIS = 'obligated_in_window';
export const BASIS_NOTE =
  'Net new obligations recorded inside the window (sum of contract actions), NOT total/lifetime award value. ' +
  'DoD contract actions publish ~90 days late, so recent rows skew to civilian agencies.';

// Search awards (award-level; "Award Amount" is CUMULATIVE — see header).
export async function searchAwards(opts = {}) {
  const {
    keywords = ['defense', 'military'],
    limit = 20,
    sortField = 'Award Amount',
    order = 'desc',
    awardTypeCodes = CONTRACT_CODES,
    days = 30,
  } = opts;

  const body = {
    filters: {
      keywords,
      time_period: [{ start_date: daysAgo(days), end_date: daysAgo(0) }],
      award_type_codes: awardTypeCodes,
    },
    fields: [
      'Award ID',
      'Recipient Name',
      'Award Amount',
      'Description',
      'Awarding Agency',
      'Start Date',
      'Award Type',
    ],
    limit,
    page: 1,
    sort: sortField,
    order,
  };

  return postSearch('spending_by_award', body);
}

// Search contract ACTIONS (transactions) dated inside the window. Each row's
// "Transaction Amount" is the obligation that one action added (negative for a
// de-obligation), so the ranking reflects money moved in the window.
export async function searchTransactions(opts = {}) {
  const {
    keywords = DEFENSE_KEYWORDS,
    limit = 50,
    awardTypeCodes = CONTRACT_CODES,
    days = DEFENSE_WINDOW_DAYS,
  } = opts;

  const window = { start: daysAgo(days), end: daysAgo(0), days };
  const body = {
    filters: {
      keywords,
      time_period: [{ start_date: window.start, end_date: window.end }],
      award_type_codes: awardTypeCodes,
    },
    fields: [
      'Award ID',
      'Mod',
      'Recipient Name',
      'Action Date',
      'Action Type',
      'Transaction Amount',
      'Transaction Description',
      'Awarding Agency',
      'Awarding Sub Agency',
      'Award Type',
    ],
    limit,
    page: 1,
    sort: 'Transaction Amount',
    order: 'desc',
  };

  const res = await postSearch('spending_by_transaction', body);
  return { ...res, window };
}

// The search API usually answers in 1-4 s but occasionally hangs. Two
// 12 s attempts fit inside briefing.mjs's 30 s per-source budget; an HTTP error
// status is returned as-is (not retried).
const SEARCH_ATTEMPT_MS = 12000;
const SEARCH_ATTEMPTS = 2;

async function postSearch(endpoint, body) {
  let lastError;
  for (let attempt = 1; attempt <= SEARCH_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_ATTEMPT_MS);
    try {
      const res = await fetch(`${BASE}/search/${endpoint}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        return { error: `HTTP ${res.status}: ${errBody.slice(0, 300)}`, results: [] };
      }
      return await res.json();
    } catch (e) {
      lastError = e;
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: `${lastError?.message || 'request failed'} (after ${SEARCH_ATTEMPTS} attempts)`, results: [] };
}

// A base award is modification "0" (the API reports it as "0"; FPDS sometimes
// leaves it blank). Anything else is a modification to an existing award.
function isBaseAction(mod) {
  const m = String(mod ?? '').trim();
  return m === '' || m === '0';
}

const cents = n => Math.round(n * 100) / 100;

/**
 * Fold transaction rows into one row per award, summing the obligations
 * inside the window. Pure — exported for tests.
 * @param {Array} rows - spending_by_transaction results
 * @param {{limit?: number}} opts
 */
export function summarizeObligations(rows = [], { limit = 10 } = {}) {
  const byAward = new Map();
  for (const r of rows || []) {
    const amt = Number(r?.['Transaction Amount']);
    if (!Number.isFinite(amt)) continue;
    const key = r.generated_internal_id || r['Award ID'];
    if (!key) continue;
    let a = byAward.get(key);
    if (!a) {
      a = {
        awardId: r['Award ID'],
        recipient: r['Recipient Name'],
        agency: r['Awarding Agency'] || null,
        subAgency: r['Awarding Sub Agency'] || null,
        type: r['Award Type'] || null,
        obligatedInWindow: 0,
        actions: 0,
        newAward: false,
        date: null,
        latestMod: null,
        description: null,
        largest: -Infinity,
      };
      byAward.set(key, a);
    }
    a.obligatedInWindow += amt;
    a.actions += 1;
    if (isBaseAction(r['Mod'])) a.newAward = true;
    const d = r['Action Date'] || null;
    if (d && (!a.date || d > a.date)) {
      a.date = d;
      a.latestMod = r['Mod'] ?? null;
    }
    if (amt > a.largest) {
      a.largest = amt;
      a.description = r['Transaction Description'] || a.description;
    }
  }

  return [...byAward.values()]
    .filter(a => a.obligatedInWindow > 0)
    .sort((x, y) => y.obligatedInWindow - x.obligatedInWindow)
    .slice(0, limit)
    .map(({ largest, ...a }) => ({
      ...a,
      obligatedInWindow: cents(a.obligatedInWindow),
      // `amount` is kept for existing consumers (dashboard/inject.mjs, /api/state).
      // It is the in-window obligation, and `amountBasis` says so.
      amount: cents(a.obligatedInWindow),
      amountBasis: AMOUNT_BASIS,
    }));
}

// Search for defense-keyword contract actions inside the window
export async function getDefenseSpending(days = DEFENSE_WINDOW_DAYS) {
  return searchTransactions({
    keywords: DEFENSE_KEYWORDS,
    limit: 50,
    awardTypeCodes: CONTRACT_CODES,
    days,
  });
}

// Get top agencies by spending
export async function getAgencySpending() {
  return safeFetch(`${BASE}/references/toptier_agencies/`);
}

// Briefing
export async function briefing() {
  const [defense, agencies] = await Promise.all([
    getDefenseSpending(DEFENSE_WINDOW_DAYS),
    getAgencySpending(),
  ]);

  return {
    source: 'USAspending',
    timestamp: new Date().toISOString(),
    defenseWindow: defense?.window || null,
    defenseAmountBasis: AMOUNT_BASIS,
    defenseBasisNote: BASIS_NOTE,
    recentDefenseContracts: summarizeObligations(defense?.results || [], { limit: 10 }),
    topAgencies: (agencies?.results || []).slice(0, 10).map(a => ({
      name: a.agency_name,
      budget: a.budget_authority_amount,
      obligations: a.obligated_amount,
      outlays: a.outlay_amount,
    })),
    ...(defense?.error ? { defenseError: defense.error } : {}),
  };
}

if (process.argv[1]?.endsWith('usaspending.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
