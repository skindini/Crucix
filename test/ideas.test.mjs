// LLM trade ideas — ticker validation, timeout config, failure classification
// Uses Node.js built-in test runner (node:test) — no extra dependencies, no network

import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTicker,
  parseIdeasResponse,
  resolveIdeasTimeoutMs,
  classifyLLMError,
  generateLLMIdeas,
  generateLLMIdeasDetailed,
  IDEAS_SYSTEM_PROMPT,
  DEFAULT_IDEAS_TIMEOUT_MS,
} from '../lib/llm/ideas.mjs';

const SWEEP = { fred: [{ id: 'VIXCLS', value: 21 }], energy: { wti: 70, brent: 74, natgas: 3 } };

function fakeProvider({ name = 'fake', model = 'm1', text, error } = {}) {
  const calls = [];
  return {
    name, model, isConfigured: true, calls,
    async complete(system, user, opts) {
      calls.push({ system, user, opts });
      if (error) throw error;
      return { text, usage: { inputTokens: 0, outputTokens: 0 }, model };
    },
  };
}

const idea = (over = {}) => ({
  title: 'Energy bid', type: 'LONG', ticker: 'XLE', confidence: 'MEDIUM',
  rationale: 'WTI up', risk: 'Demand shock', horizon: 'Weeks', signals: ['WTI', 'Brent'], ...over,
});

describe('normalizeTicker', () => {
  for (const ok of ['XLE', 'LMT', 'GLD', 'BRK.B', 'BRK-B', 'SHEL.L', 'RY.TO', 'CL=F', 'BZ=F', 'EURUSD=X', '^VIX', 'BTC-USD', '7203.T']) {
    it(`accepts ${ok}`, () => assert.deepEqual(normalizeTicker(ok), { ticker: ok, malformed: false }));
  }

  it('normalizes case, whitespace and a leading $', () => {
    assert.deepEqual(normalizeTicker('  $xle '), { ticker: 'XLE', malformed: false });
  });

  for (const bad of [
    'BZ-CL spread (Long Brent / Short WTI)',
    'BZ-CL',
    'XLE/XLU',
    'LMT, RTX',
    'Long LMT',
    '/CL',
    'ITA + XAR',
    'Defense ETFs',
    'TOOLONGSYMBOL',
    '<img src=x>',
  ]) {
    it(`nulls and flags ${JSON.stringify(bad)}`, () => assert.deepEqual(normalizeTicker(bad), { ticker: null, malformed: true }));
  }

  it('treats a non-string as malformed', () => {
    assert.deepEqual(normalizeTicker(['XLE', 'XLU']), { ticker: null, malformed: true });
    assert.deepEqual(normalizeTicker(42), { ticker: null, malformed: true });
  });

  it('treats absent / N/A as null but not malformed', () => {
    for (const v of [null, undefined, '', 'N/A', 'none', 'null']) {
      assert.deepEqual(normalizeTicker(v), { ticker: null, malformed: false }, String(v));
    }
  });
});

describe('parseIdeasResponse', () => {
  it('nulls a spread ticker, keeps the idea, and counts it', () => {
    const stats = {};
    const text = '```json\n' + JSON.stringify([
      idea(),
      idea({ title: 'Brent-WTI widening', ticker: 'BZ-CL spread (Long Brent / Short WTI)', rationale: 'Long Brent / short WTI spread' }),
    ]) + '\n```';
    const ideas = parseIdeasResponse(text, stats);
    assert.equal(ideas.length, 2);
    assert.equal(ideas[0].ticker, 'XLE');
    assert.equal(ideas[1].ticker, null);
    assert.equal(ideas[1].rationale, 'Long Brent / short WTI spread');
    assert.equal(stats.tickersNulled, 1);
    assert.deepEqual(stats.nulledTickers, ['BZ-CL spread (Long Brent / Short WTI)']);
    assert.equal(stats.parsed, 2);
  });

  it('keeps risk and signals and tags source=llm', () => {
    const [i] = parseIdeasResponse(JSON.stringify([idea()]));
    assert.equal(i.source, 'llm');
    assert.equal(i.risk, 'Demand shock');
    assert.deepEqual(i.signals, ['WTI', 'Brent']);
  });

  it('drops ideas missing required fields and counts them', () => {
    const stats = {};
    const ideas = parseIdeasResponse(JSON.stringify([idea(), { title: 'no type' }, null]), stats);
    assert.equal(ideas.length, 1);
    assert.equal(stats.droppedIncomplete, 2);
  });

  it('extracts the array from surrounding prose', () => {
    const ideas = parseIdeasResponse('Here you go:\n' + JSON.stringify([idea()]) + '\nGood luck.');
    assert.equal(ideas.length, 1);
  });

  it('returns null on non-JSON', () => {
    assert.equal(parseIdeasResponse('no json here'), null);
    assert.equal(parseIdeasResponse(''), null);
  });
});

describe('prompt', () => {
  it('asks for ONE tradable symbol or null and forbids spreads in ticker', () => {
    assert.match(IDEAS_SYSTEM_PROMPT, /exactly ONE tradable symbol/);
    assert.match(IDEAS_SYSTEM_PROMPT, /NOT "BZ-CL spread"/);
    assert.match(IDEAS_SYSTEM_PROMPT, /"ticker": "ONE tradable symbol, or null"/);
  });

  it('warns the model off reading a lifetime award value as fresh', () => {
    assert.match(IDEAS_SYSTEM_PROMPT, /never call a lifetime award value a fresh award/);
  });
});

describe('resolveIdeasTimeoutMs', () => {
  afterEach(() => mock.restoreAll());

  it('defaults claude-cli to 240 s and everything else to 90 s', () => {
    assert.equal(resolveIdeasTimeoutMs({ name: 'claude-cli' }, {}), 240000);
    assert.equal(resolveIdeasTimeoutMs({ name: 'openai' }, {}), DEFAULT_IDEAS_TIMEOUT_MS);
    assert.equal(DEFAULT_IDEAS_TIMEOUT_MS, 90000);
  });

  it('LLM_IDEAS_TIMEOUT_MS overrides every provider', () => {
    assert.equal(resolveIdeasTimeoutMs({ name: 'claude-cli' }, { LLM_IDEAS_TIMEOUT_MS: '300000' }), 300000);
    assert.equal(resolveIdeasTimeoutMs({ name: 'openai' }, { LLM_IDEAS_TIMEOUT_MS: ' 120000 ' }), 120000);
  });

  it('ignores an invalid override (warns, never throws)', () => {
    const warn = mock.method(console, 'warn', () => {});
    assert.equal(resolveIdeasTimeoutMs({ name: 'claude-cli' }, { LLM_IDEAS_TIMEOUT_MS: 'soon' }), 240000);
    assert.equal(resolveIdeasTimeoutMs({ name: 'claude-cli' }, { LLM_IDEAS_TIMEOUT_MS: '-5' }), 240000);
    assert.equal(resolveIdeasTimeoutMs({ name: 'claude-cli' }, { LLM_IDEAS_TIMEOUT_MS: '' }), 240000);
    assert.equal(warn.mock.callCount(), 2);
  });
});

describe('classifyLLMError', () => {
  it('timeout: claude-cli, fetch AbortSignal.timeout, ETIMEDOUT', () => {
    assert.equal(classifyLLMError(new Error('claude-cli: timed out after 90000ms')), 'timeout');
    const dom = new Error('The operation was aborted due to timeout'); dom.name = 'TimeoutError';
    assert.equal(classifyLLMError(dom), 'timeout');
    const e = new Error('x'); e.code = 'ETIMEDOUT';
    assert.equal(classifyLLMError(e), 'timeout');
  });

  it('quota: the spend-limit refusals seen on the body', () => {
    assert.equal(classifyLLMError(new Error("claude-cli exited 1: You've hit your org's monthly spend limit · your weekly limit resets 2am")), 'quota');
    assert.equal(classifyLLMError(new Error('Anthropic API 429: rate_limit_error')), 'quota');
  });

  it('error: everything else', () => {
    assert.equal(classifyLLMError(new Error('claude-cli exited 1: Error: Reached max turns (1)')), 'error');
    assert.equal(classifyLLMError(undefined), 'error');
  });
});

describe('generateLLMIdeasDetailed', () => {
  afterEach(() => mock.restoreAll());

  it('passes the resolved timeout to the provider', async () => {
    mock.method(console, 'log', () => {});
    const p = fakeProvider({ name: 'claude-cli', text: JSON.stringify([idea()]) });
    const out = await generateLLMIdeasDetailed(p, SWEEP, null, [], { env: {} });
    assert.equal(p.calls[0].opts.timeout, 240000);
    assert.equal(out.failure, null);
    assert.equal(out.ideas.length, 1);

    const p2 = fakeProvider({ name: 'claude-cli', text: JSON.stringify([idea()]) });
    await generateLLMIdeasDetailed(p2, SWEEP, null, [], { env: { LLM_IDEAS_TIMEOUT_MS: '150000' } });
    assert.equal(p2.calls[0].opts.timeout, 150000);
  });

  it('logs a timeout distinctly and reports kind=timeout', async () => {
    const err = mock.method(console, 'error', () => {});
    const e = new Error('claude-cli: timed out after 240000ms'); e.name = 'TimeoutError';
    const out = await generateLLMIdeasDetailed(fakeProvider({ name: 'claude-cli', error: e }), SWEEP, null, [], { env: {} });
    assert.equal(out.ideas, null);
    assert.equal(out.failure.kind, 'timeout');
    assert.equal(out.failure.timeoutMs, 240000);
    const line = err.mock.calls.map(c => c.arguments.join(' ')).join('\n');
    assert.match(line, /Generation failed \[timeout\]/);
    assert.match(line, /LLM_IDEAS_TIMEOUT_MS=240000/);
  });

  it('logs a spend-limit refusal as [quota], other errors as [error]', async () => {
    const err = mock.method(console, 'error', () => {});
    const q = await generateLLMIdeasDetailed(fakeProvider({ error: new Error("You've hit your org's monthly spend limit") }), SWEEP, null, [], { env: {} });
    const o = await generateLLMIdeasDetailed(fakeProvider({ error: new Error('Reached max turns (1)') }), SWEEP, null, [], { env: {} });
    assert.equal(q.failure.kind, 'quota');
    assert.equal(o.failure.kind, 'error');
    const lines = err.mock.calls.map(c => c.arguments.join(' '));
    assert.match(lines[0], /Generation failed \[quota\]/);
    assert.match(lines[1], /Generation failed \[error\]/);
  });

  it('counts nulled tickers in stats and the sweep log', async () => {
    mock.method(console, 'log', () => {});
    const warn = mock.method(console, 'warn', () => {});
    const text = JSON.stringify([idea(), idea({ title: 'Spread', ticker: 'BZ-CL spread (Long Brent / Short WTI)' })]);
    const out = await generateLLMIdeasDetailed(fakeProvider({ text }), SWEEP, null, [], { env: {} });
    assert.equal(out.stats.tickersNulled, 1);
    assert.equal(out.ideas[1].ticker, null);
    assert.match(warn.mock.calls[0].arguments.join(' '), /Nulled 1 malformed ticker\(s\): "BZ-CL spread/);
  });

  it('reports kind=parse when the model returns no usable ideas', async () => {
    mock.method(console, 'log', () => {});
    mock.method(console, 'warn', () => {});
    const out = await generateLLMIdeasDetailed(fakeProvider({ text: 'sorry' }), SWEEP, null, [], { env: {} });
    assert.equal(out.failure.kind, 'parse');
  });

  it('generateLLMIdeas keeps its old contract (array or null)', async () => {
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});
    assert.equal((await generateLLMIdeas(fakeProvider({ text: JSON.stringify([idea()]) }), SWEEP, null, [])).length, 1);
    assert.equal(await generateLLMIdeas(fakeProvider({ error: new Error('x') }), SWEEP, null, []), null);
    assert.equal(await generateLLMIdeas(null, SWEEP, null, []), null);
  });
});
