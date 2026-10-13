// Dashboard XSS guard: feed-derived strings must reach the DOM as inert text.
// Runs the real jarvis.html script in a vm against a recording stub DOM, feeds it
// poisoned data through both entry points (fetch /api/data and SSE /events), and
// asserts no innerHTML write or globe tooltip carries a live tag from the payloads.
// Uses Node.js built-in test runner (node:test) — no extra dependencies, no network.
// JARVIS_HTML=<path> points it at another copy (e.g. to prove it fails on the old file).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HTML_PATH = process.env.JARVIS_HTML
  || fileURLToPath(new URL('../dashboard/public/jarvis.html', import.meta.url));

// One payload per bypass class. Each carries an XSS<n> marker so a leak is unambiguous.
const PAYLOADS = [
  '<script>XSS1()</script>',
  '<img src=x onerror=XSS2()//',            // unclosed tag: survived the old cleanText
  '&lt;img src=x onerror=XSS3()//',         // entity-encoded (Telegram decodes after strip)
  '"><b onmouseover=XSS4()>x</b>',          // attribute breakout
  "'><svg onload=XSS5()>",
];
// A live tag carrying a marker, or an event-handler attribute carrying one.
const LIVE = /<\s*(script|img|svg|b)\b[^>]*XSS\d|<[a-z][^>]*\son\w+\s*=\s*XSS\d/i;

function loadDashboard({ width = 1400 } = {}) {
  const html = readFileSync(HTML_PATH, 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).find((s) => s.includes('function renderLeftRail'));
  assert.ok(script, 'main dashboard script not found');

  const writes = [];   // every innerHTML assignment
  const calls = [];    // [method, args] for every stubbed call (globe.pointsData etc.)
  const listeners = {};
  const cache = new Map();
  const stub = (name) => {
    if (cache.has(name)) return cache.get(name);
    const fn = function () {};
    const p = new Proxy(fn, {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return () => 0;
        if (prop === Symbol.iterator) return function* () { yield 1; yield 1; }; // d3 projection [x,y]
        if (prop === 'then') return undefined;
        if (prop === 'innerHTML' || prop === 'textContent') return '';
        if (prop === 'addEventListener') return (ev, cb) => { (listeners[ev] ||= []).push(cb); };
        if (prop === 'getBoundingClientRect') return () => ({ width: 800, height: 600, left: 0, top: 0 });
        if (prop === 'clientX' || prop === 'clientY') return 10;
        return stub(`${name}.${String(prop)}`);
      },
      set(_t, prop, value) {
        if (prop === 'innerHTML') writes.push(String(value));
        return true;
      },
      apply(_t, _this, args) { calls.push([name.split('.').pop(), args]); return p; },
      construct() { return p; },
    });
    cache.set(name, p);
    return p;
  };

  let es = null;
  let fetchBody = null;
  const ctx = {
    console, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: (cb) => cb(),
    document: stub('document'),
    window: { innerWidth: width, addEventListener() {}, matchMedia: () => ({ matches: false }) },
    location: { protocol: 'http:', href: 'http://localhost:3117/' },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { userAgent: 'node' },
    gsap: stub('gsap'), d3: stub('d3'), topojson: stub('topojson'), Globe: stub('Globe'), THREE: stub('THREE'),
    fetch: async (url) => (String(url).startsWith('/api/')
      ? { ok: true, status: 200, json: async () => fetchBody }
      : { ok: true, status: 200, json: async () => ({ objects: { countries: {} } }) }), // world atlas
    EventSource: class { constructor() { es = this; } close() {} },
  };
  ctx.globalThis = ctx;
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(`${script}\n;globalThis.__t = { setD: (v) => { D = v; }, getD: () => D, showPopup };`, ctx);
  return {
    ctx, writes, calls, listeners,
    setFetchBody: (b) => { fetchBody = b; },
    sse: () => es,
  };
}

// The inline sample D has every panel's real shape; poison every string in it.
function poisoned(d) {
  let i = 0;
  const walk = (v) => {
    if (typeof v === 'string') return v + PAYLOADS[i++ % PAYLOADS.length];
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(d);
  // Fields the audit named, set explicitly so they exist whatever the sample holds.
  out.ideas = [{ type: 'LONG', ticker: PAYLOADS[1], title: PAYLOADS[1], text: PAYLOADS[0],
    risk: PAYLOADS[3], horizon: PAYLOADS[4], confidence: PAYLOADS[2] }];
  out.newsFeed = [{ headline: PAYLOADS[1], source: PAYLOADS[3], url: 'https://ex.com/a?b=1&c="2"',
    timestamp: '2026-10-13T00:00:00Z', urgent: true }];
  out.tg = { ...out.tg, urgent: [{ channel: PAYLOADS[4], text: PAYLOADS[2], views: 5, date: '2026-10-13T00:00:00Z' }],
    topPosts: [{ channel: 'c', text: PAYLOADS[1], date: '2026-10-13T00:00:00Z' }] };
  return out;
}

const flush = () => new Promise((r) => setImmediate(r));

function assertInert(writes, calls, label, { markers = true } = {}) {
  assert.ok(writes.length >= 4, `${label}: render produced too few innerHTML writes (${writes.length})`);
  for (const w of writes) assert.doesNotMatch(w, LIVE, `${label}: live payload reached innerHTML`);
  // Flat map: markers open popups (innerHTML) from click closures — fire them all.
  const clicks = calls.filter(([m, a]) => m === 'on' && a[0] === 'click' && typeof a[1] === 'function');
  const before = writes.length;
  for (const [, a] of clicks) { try { a[1]({ clientX: 1, clientY: 1, stopPropagation() {} }); } catch {} }
  for (const w of writes.slice(before)) assert.doesNotMatch(w, LIVE, `${label}: live payload in map popup`);
  // Globe: popHead/popMeta feed an HTML tooltip (pointLabel), popText the popup.
  const pts = calls.filter(([m, a]) => m === 'pointsData' && Array.isArray(a[0])).flatMap(([, a]) => a[0]);
  if (markers) assert.ok(pts.length + clicks.length > 10, `${label}: no map markers recorded`);
  for (const p of pts) {
    for (const k of ['popHead', 'popMeta', 'popText']) {
      if (typeof p[k] === 'string') assert.doesNotMatch(p[k], LIVE, `${label}: live payload in point.${k}`);
    }
  }
}

for (const [mode, width] of [['flat map (desktop)', 1400], ['globe (mobile)', 800]])
describe(`dashboard escapes feed data — ${mode}`, () => {
  it('fetch /api/data entry point renders poisoned feeds inert', async () => {
    const dash = loadDashboard({ width });
    const bad = poisoned(dash.ctx.__t.getD());
    dash.ctx.__t.setD(null);               // server mode: no inline data → fetch
    dash.setFetchBody(bad);
    for (const cb of dash.listeners.DOMContentLoaded || []) cb();
    await flush(); await flush();
    assertInert(dash.writes, dash.calls, 'fetch');
  });

  it('SSE update entry point renders poisoned feeds inert', async () => {
    const dash = loadDashboard({ width });
    const bad = poisoned(dash.ctx.__t.getD());
    dash.setFetchBody(dash.ctx.__t.getD());
    dash.ctx.__t.setD(null);
    for (const cb of dash.listeners.DOMContentLoaded || []) cb();
    await flush(); await flush();
    assert.ok(dash.sse(), 'SSE not connected');
    dash.writes.length = 0; dash.calls.length = 0;
    dash.sse().onmessage({ data: JSON.stringify({ type: 'update', data: bad }) });
    // the flat map isn't redrawn on SSE updates (globe is) — markers are covered by the fetch test
    assertInert(dash.writes, dash.calls, 'sse', { markers: width <= 1100 });
  });

  it('map popup stays inert for poisoned head/text/meta', async () => {
    const dash = loadDashboard({ width });
    dash.setFetchBody(poisoned(dash.ctx.__t.getD()));
    dash.ctx.__t.setD(null);
    for (const cb of dash.listeners.DOMContentLoaded || []) cb();
    await flush(); await flush();
    const pts = dash.calls.filter(([m, a]) => m === 'pointsData' && Array.isArray(a[0])).flatMap(([, a]) => a[0]);
    dash.writes.length = 0;
    for (const p of pts.slice(0, 50)) dash.ctx.__t.showPopup({ clientX: 1, clientY: 1 }, p.popHead, p.popText, p.popMeta);
    for (const w of dash.writes) assert.doesNotMatch(w, LIVE);
  });

  it('a 401/503 from /api/data is not rendered as data', async () => {
    const dash = loadDashboard();
    dash.ctx.__t.setD(null);
    dash.ctx.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) });
    for (const cb of dash.listeners.DOMContentLoaded || []) cb();
    await flush(); await flush();
    assert.equal(dash.ctx.__t.getD(), null);
  });
});

describe('escape helpers', () => {
  const { ctx } = loadDashboard();
  const { escapeData, escapeHtml, cleanText } = vm.runInContext('({ escapeData, escapeHtml, cleanText })', ctx);

  it('escapes every string leaf, leaves non-strings alone', () => {
    const out = escapeData({ a: PAYLOADS, n: 3, b: true, z: null, o: { s: '<x>' } });
    for (const s of out.a) assert.doesNotMatch(s, /[<>"']/);
    assert.equal(out.n, 3); assert.equal(out.b, true); assert.equal(out.z, null);
    assert.equal(out.o.s, '&lt;x&gt;');
  });

  it('cleanText of escaped text never yields a raw "<"', () => {
    for (const p of PAYLOADS) assert.ok(!cleanText(escapeHtml(p)).includes('<'), p);
  });

  it('RSS-encoded ampersands still display as "&"', () => {
    assert.equal(cleanText(escapeHtml('AT&amp;T')), 'AT&amp;T'); // innerHTML renders "AT&T"
  });
});
