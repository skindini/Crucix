// LLM-Powered Trade Ideas — generates actionable ideas from sweep data + delta context

// ─── Timeout ────────────────────────────────────────────────────────────────
// 90 s was hard-coded for every provider. claude-cli pays a process spawn plus
// session start-up before the model sees the prompt, and on the alfred body it
// timed out 81 times at 90 s (2026-09 log). The default is now per-provider and
// LLM_IDEAS_TIMEOUT_MS overrides it for all of them. Keep it well under
// REFRESH_INTERVAL_MINUTES — a sweep holds its lock while it waits.
export const DEFAULT_IDEAS_TIMEOUT_MS = 90_000;
export const PROVIDER_IDEAS_TIMEOUT_MS = Object.freeze({
  'claude-cli': 240_000,
});

/**
 * Resolve the idea-generation timeout: LLM_IDEAS_TIMEOUT_MS (a positive integer
 * of milliseconds) wins; otherwise the provider's default; otherwise 90 s.
 * An unparseable override is ignored (with a warning), never fatal.
 */
export function resolveIdeasTimeoutMs(provider, env = process.env) {
  const raw = env?.LLM_IDEAS_TIMEOUT_MS;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(String(raw).trim());
    if (Number.isFinite(n) && n > 0) return Math.round(n);
    console.warn(`[LLM Ideas] Ignoring invalid LLM_IDEAS_TIMEOUT_MS=${JSON.stringify(raw)} — using the provider default`);
  }
  return PROVIDER_IDEAS_TIMEOUT_MS[provider?.name] ?? DEFAULT_IDEAS_TIMEOUT_MS;
}

/**
 * Bucket an LLM failure so the sweep log (and ideasSource) can say WHY:
 *   timeout — the provider did not answer inside the limit
 *   quota   — spend/usage/rate limit (on the body, the majority of failures)
 *   error   — everything else
 */
export function classifyLLMError(err) {
  const name = err?.name || '';
  const msg = String(err?.message ?? err ?? '');
  if (name === 'TimeoutError' || err?.code === 'ETIMEDOUT' || /timed out|timeout/i.test(msg)) return 'timeout';
  if (/spend limit|usage limit|rate[ _-]?limit|quota|insufficient[ _]credit|credit balance|limit resets|\b429\b/i.test(msg)) return 'quota';
  return 'error';
}

// ─── Ticker validation ─────────────────────────────────────────────────────
// `ticker` feeds MIDAS as an instrument. It must be ONE tradable symbol:
//   XLE · BRK.B · BRK-B · SHEL.L · RY.TO · CL=F · EURUSD=X · ^VIX · BTC-USD
// Rejected (nulled): spreads/pairs/baskets/prose — "BZ-CL spread (Long Brent /
// Short WTI)", "XLE/XLU", "LMT, RTX", "/CL". A dash suffix is allowed only as a
// one-letter share class or a crypto quote currency, so "BZ-CL" does not pass.
const TICKER_RE = /^\^?[A-Z0-9]{1,6}(?:\.[A-Z0-9]{1,3}|-[A-Z]|-(?:USD|USDT|USDC|EUR)|=F|=X)?$/;
const NULLISH_TICKERS = new Set(['', 'N/A', 'NA', 'NONE', 'NULL', '-', '—']);

/**
 * @returns {{ ticker: string|null, malformed: boolean }}
 *   malformed=true means the model supplied something that is not a tradable
 *   symbol (counted in the sweep log); an absent/"N/A" ticker is not malformed.
 */
export function normalizeTicker(raw) {
  if (raw == null) return { ticker: null, malformed: false };
  if (typeof raw !== 'string') return { ticker: null, malformed: true };
  const t = raw.trim().replace(/^\$/, '').toUpperCase();
  if (NULLISH_TICKERS.has(t)) return { ticker: null, malformed: false };
  if (TICKER_RE.test(t)) return { ticker: t, malformed: false };
  return { ticker: null, malformed: true };
}

// ─── Prompt ────────────────────────────────────────────────────────────────
export const IDEAS_SYSTEM_PROMPT = `You are a quantitative analyst at a macro intelligence firm. You receive structured OSINT + economic data from 25 sources and produce 5-8 actionable trade ideas.

Rules:
- Each idea must cite specific data points from the input
- Include entry rationale, risk factors, and time horizon
- Blend geopolitical, economic, and market signals — cross-correlate across domains
- Be specific: name instruments (tickers, futures, ETFs), not vague sectors
- "ticker" is exactly ONE tradable symbol as quoted on its venue (e.g. XLE, LMT, GLD, CL=F) or null. Never put a spread, pair, ratio, basket, or words in "ticker" (NOT "BZ-CL spread", NOT "XLE/XLU", NOT "LMT, RTX"). Describe spreads and pairs in the rationale and put the primary leg — or null — in "ticker"
- Contract amounts are NEW obligations inside the stated window unless explicitly labelled lifetime/total; never call a lifetime award value a fresh award
- If delta shows significant changes, lead with those
- Do NOT repeat ideas from the "previous ideas" list unless conditions have materially changed
- Rate confidence: HIGH (multiple confirming signals), MEDIUM (thesis supported), LOW (speculative)

Output ONLY valid JSON array. Each object:
{
  "title": "Short title (max 10 words)",
  "type": "LONG|SHORT|HEDGE|WATCH|AVOID",
  "ticker": "ONE tradable symbol, or null",
  "confidence": "HIGH|MEDIUM|LOW",
  "rationale": "2-3 sentence explanation citing specific data",
  "risk": "Key risk factor",
  "horizon": "Intraday|Days|Weeks|Months",
  "signals": ["signal1", "signal2"]
}`;

/**
 * Generate LLM trade ideas and report why when there are none.
 * @returns {Promise<{ideas: Array|null, failure: null|{kind: 'unconfigured'|'compact'|'timeout'|'quota'|'error'|'parse', message: string, elapsedMs?: number, timeoutMs?: number}, stats: object}>}
 */
export async function generateLLMIdeasDetailed(provider, sweepData, delta, previousIdeas = [], opts = {}) {
  const stats = { parsed: 0, droppedIncomplete: 0, tickersNulled: 0, nulledTickers: [] };
  if (!provider?.isConfigured) {
    return { ideas: null, failure: { kind: 'unconfigured', message: 'provider not configured' }, stats };
  }

  let context;
  try {
    context = compactSweepForLLM(sweepData, delta, previousIdeas);
  } catch (err) {
    console.error('[LLM Ideas] Failed to compact sweep data:', err.message);
    return { ideas: null, failure: { kind: 'compact', message: err.message }, stats };
  }

  const timeoutMs = opts.timeoutMs ?? resolveIdeasTimeoutMs(provider, opts.env ?? process.env);
  const label = `${provider.name}${provider.model ? `/${provider.model}` : ''}`;
  const started = Date.now();
  try {
    const result = await provider.complete(IDEAS_SYSTEM_PROMPT, context, { maxTokens: 8192, timeout: timeoutMs });
    const elapsedMs = Date.now() - started;
    console.log(`[LLM Ideas] ${label} answered in ${(elapsedMs / 1000).toFixed(1)}s (limit ${(timeoutMs / 1000).toFixed(0)}s)`);
    const ideas = parseIdeasResponse(result.text, stats);
    if (stats.tickersNulled > 0) {
      console.warn(`[LLM Ideas] Nulled ${stats.tickersNulled} malformed ticker(s): ${stats.nulledTickers.map(t => JSON.stringify(t)).join(', ')}`);
    }
    if (ideas && ideas.length > 0) {
      return { ideas, failure: null, stats };
    }
    console.warn('[LLM Ideas] No valid ideas parsed from response. Raw length:', result.text?.length, 'First 1000 chars:', JSON.stringify(result.text?.slice(0, 1000)));
    return { ideas: null, failure: { kind: 'parse', message: 'no valid ideas parsed', elapsedMs, timeoutMs }, stats };
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const kind = classifyLLMError(err);
    const message = err?.message || String(err);
    if (kind === 'timeout') {
      console.error(`[LLM Ideas] Generation failed [timeout] after ${(elapsedMs / 1000).toFixed(1)}s — ${label} gave no answer within LLM_IDEAS_TIMEOUT_MS=${timeoutMs}: ${message}`);
    } else if (kind === 'quota') {
      console.error(`[LLM Ideas] Generation failed [quota] — ${label} refused on a spend/usage limit: ${message}`);
    } else {
      console.error(`[LLM Ideas] Generation failed [error]: ${message}`);
    }
    return { ideas: null, failure: { kind, message, elapsedMs, timeoutMs }, stats };
  }
}

/**
 * Generate LLM-enhanced trade ideas from sweep data.
 * @param {LLMProvider} provider - configured LLM provider
 * @param {object} sweepData - synthesized dashboard data
 * @param {object|null} delta - delta from last sweep
 * @param {Array} previousIdeas - ideas from previous runs (for dedup)
 * @returns {Promise<Array|null>} - array of idea objects, or null on any failure
 */
export async function generateLLMIdeas(provider, sweepData, delta, previousIdeas = [], opts = {}) {
  const { ideas } = await generateLLMIdeasDetailed(provider, sweepData, delta, previousIdeas, opts);
  return ideas;
}

const fmtMillions = n => `$${((Number(n) || 0) / 1e6).toFixed(0)}M`;

/**
 * The DEFENSE line of the LLM context. Every amount says what it is: rows with
 * basis "obligated_in_window" are new money obligated in the sweep window; rows
 * without it (runs saved before the USAspending fix) were lifetime award totals
 * and are labelled that way so they can never read as a fresh award.
 */
export function formatDefenseForLLM(defense, max = 3) {
  const rows = (defense || []).slice(0, max);
  if (!rows.length) return null;
  const parts = rows.map(d => {
    const who = d.recipient || 'unknown recipient';
    const where = [d.agency, d.newAward === true ? 'new award' : d.newAward === false ? 'modification of an existing award' : null, d.date]
      .filter(Boolean).join('; ');
    const tail = where ? ` (${where})` : '';
    if (d.basis === 'obligated_in_window') {
      return `${fmtMillions(d.amount)} newly obligated to ${who}${tail}`;
    }
    return `${fmtMillions(d.amount)} TOTAL LIFETIME award value, NOT new money — ${who}${tail}`;
  });
  const windowed = rows.every(d => d.basis === 'obligated_in_window');
  const header = windowed
    ? 'FEDERAL_CONTRACT_OBLIGATIONS (defense-keyword search; amounts = new money obligated in the last 14 days, NOT total contract value; DoD actions publish ~90 days late, so these are mostly civilian agencies)'
    : 'FEDERAL_CONTRACTS (defense-keyword search; see per-row amount basis)';
  return `${header}: ${parts.join('; ')}`;
}

/**
 * Compact sweep data to ~8KB for token efficiency.
 */
export function compactSweepForLLM(data, delta, previousIdeas) {
  const sections = [];

  // Economic indicators
  if (data.fred?.length) {
    const key = data.fred.filter(f => ['VIXCLS', 'DFF', 'DGS10', 'DGS2', 'T10Y2Y', 'BAMLH0A0HYM2', 'DTWEXBGS', 'MORTGAGE30US'].includes(f.id));
    sections.push(`ECONOMIC: ${key.map(f => `${f.id}=${f.value}${f.momChange ? ` (${f.momChange > 0 ? '+' : ''}${f.momChange})` : ''}`).join(', ')}`);
  }

  // Energy
  if (data.energy) {
    sections.push(`ENERGY: WTI=$${data.energy.wti}, Brent=$${data.energy.brent}, NatGas=$${data.energy.natgas}, CrudeStocks=${data.energy.crudeStocks}bbl`);
  }

  // Metals
  if (data.metals?.gold != null || data.metals?.silver != null) {
    const gold = data.metals?.gold != null ? `$${data.metals.gold}` : 'n/a';
    const silver = data.metals?.silver != null ? `$${data.metals.silver}` : 'n/a';
    const goldChg = data.metals?.goldChangePct != null ? ` (${data.metals.goldChangePct >= 0 ? '+' : ''}${data.metals.goldChangePct}%)` : '';
    const silverChg = data.metals?.silverChangePct != null ? ` (${data.metals.silverChangePct >= 0 ? '+' : ''}${data.metals.silverChangePct}%)` : '';
    sections.push(`METALS: Gold=${gold}${goldChg}, Silver=${silver}${silverChg}`);
  }

  // BLS
  if (data.bls?.length) {
    sections.push(`LABOR: ${data.bls.map(b => `${b.id}=${b.value}`).join(', ')}`);
  }

  // Treasury
  if (data.treasury) {
    sections.push(`TREASURY: totalDebt=$${data.treasury}T`);
  }

  // Supply chain
  if (data.gscpi) {
    sections.push(`SUPPLY_CHAIN: GSCPI=${data.gscpi.value} (${data.gscpi.interpretation})`);
  }

  // Geopolitical signals (cap total OSINT text to ~1500 chars to keep prompt compact)
  const urgentPosts = (data.tg?.urgent || []).slice(0, 5);
  if (urgentPosts.length) {
    const MAX_OSINT_CHARS = 1500;
    let remaining = MAX_OSINT_CHARS;
    const lines = [];
    for (const p of urgentPosts) {
      const text = p.text || '';
      if (remaining <= 0) break;
      const trimmed = text.length > remaining ? text.substring(0, remaining) + '…' : text;
      lines.push(`- ${trimmed}`);
      remaining -= trimmed.length;
    }
    sections.push(`URGENT_OSINT:\n${lines.join('\n')}`);
  }

  // Thermal / fire detections
  if (data.thermal?.length) {
    const hotRegions = data.thermal.filter(t => t.det > 10).map(t => `${t.region}: ${t.det} detections (${t.hc} high-conf)`);
    if (hotRegions.length) sections.push(`THERMAL: ${hotRegions.join(', ')}`);
  }

  // Air activity
  if (data.air?.length) {
    const airSum = data.air.map(a => `${a.region}: ${a.total} aircraft`);
    sections.push(`AIR_ACTIVITY: ${airSum.join(', ')}`);
  }

  // Nuclear
  if (data.nuke?.length) {
    const anomalies = data.nuke.filter(n => n.anom);
    if (anomalies.length) sections.push(`NUCLEAR_ANOMALY: ${anomalies.map(n => `${n.site}: ${n.cpm}cpm`).join(', ')}`);
  }

  // WHO alerts
  if (data.who?.length) {
    sections.push(`WHO_ALERTS: ${data.who.slice(0, 3).map(w => w.title).join('; ')}`);
  }

  // Federal contract spending (labelled — see formatDefenseForLLM)
  const defenseLine = formatDefenseForLLM(data.defense);
  if (defenseLine) sections.push(defenseLine);

  // Delta context
  if (delta?.summary) {
    sections.push(`\nDELTA_SINCE_LAST_SWEEP: direction=${delta.summary.direction}, changes=${delta.summary.totalChanges}, critical=${delta.summary.criticalChanges}`);
    if (delta.signals?.escalated?.length) {
      sections.push(`ESCALATED: ${delta.signals.escalated.map(s => `${s.label}: ${s.previous}→${s.current} (${(s.changePct||0) > 0 ? '+' : ''}${(s.changePct||0).toFixed(1)}%)`).join(', ')}`);
    }
    if (delta.signals?.new?.length) {
      sections.push(`NEW_SIGNALS: ${delta.signals.new.map(s => s.label || s.text?.substring(0, 60)).join('; ')}`);
    }
  }

  // Previous ideas (for dedup)
  if (previousIdeas.length) {
    sections.push(`\nPREVIOUS_IDEAS (avoid repeating):\n${previousIdeas.map(i => `- ${i.title} [${i.type}]`).join('\n')}`);
  }

  return sections.join('\n');
}

/**
 * Parse LLM response into ideas array. Handles markdown code blocks.
 * Every idea passes through the same validation: title/type/confidence are
 * required, and a ticker that is not ONE tradable symbol is nulled and counted
 * in `stats` (tickersNulled / nulledTickers) for the sweep log.
 */
export function parseIdeasResponse(text, stats = {}) {
  if (!text) return null;
  stats.parsed ??= 0;
  stats.droppedIncomplete ??= 0;
  stats.tickersNulled ??= 0;
  stats.nulledTickers ??= [];

  // Strip markdown code block wrappers (handles trailing whitespace, thinking tags, etc.)
  let cleaned = text.trim();
  // Extract content from code blocks anywhere in the response
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```\s*$/, '');
  }
  // Strip any leading/trailing non-JSON text (find the array)
  const arrayMatch = cleaned.match(/(\[[\s\S]*\])/);
  if (arrayMatch) {
    cleaned = arrayMatch[1];
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON array from mixed text
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try { parsed = JSON.parse(match[0]); } catch { return null; }
  }
  if (!Array.isArray(parsed)) return null;

  const ideas = [];
  for (const idea of parsed) {
    if (!idea || typeof idea !== 'object' || !idea.title || !idea.type || !idea.confidence) {
      stats.droppedIncomplete += 1;
      continue;
    }
    const { ticker, malformed } = normalizeTicker(idea.ticker);
    if (malformed) {
      stats.tickersNulled += 1;
      stats.nulledTickers.push(typeof idea.ticker === 'string' ? idea.ticker : JSON.stringify(idea.ticker));
    }
    ideas.push({
      title: idea.title,
      type: idea.type,
      ticker,
      confidence: idea.confidence,
      rationale: idea.rationale || '',
      risk: idea.risk || '',
      horizon: idea.horizon || '',
      signals: Array.isArray(idea.signals) ? idea.signals : [],
      source: 'llm',
    });
  }
  stats.parsed += ideas.length;
  return ideas;
}
