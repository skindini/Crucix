// Live-data route guard (lib/access.mjs) — CRUCIX_EVENTS_TOKEN semantics.
// Uses Node.js built-in test runner (node:test) — no extra dependencies, no network.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { feedAccessOk, isLoopbackCaller } from '../lib/access.mjs';

const TOKEN = 'tok-123';
const req = (addr, host, auth) => ({
  socket: { remoteAddress: addr },
  headers: { host, ...(auth ? { authorization: auth } : {}) },
});

describe('feedAccessOk', () => {
  it('token unset → open to everyone (unchanged behaviour)', () => {
    assert.equal(feedAccessOk(req('192.168.1.176', 'alfred.local:3117'), ''), true);
    assert.equal(feedAccessOk(req('192.168.1.176', 'alfred.local:3117'), undefined), true);
  });

  it('token set → loopback callers with a loopback Host pass without it', () => {
    for (const [addr, host] of [
      ['127.0.0.1', '127.0.0.1:3117'], ['127.0.0.1', 'localhost:3117'],
      ['::1', '[::1]:3117'], ['::ffff:127.0.0.1', 'localhost'],
    ]) assert.equal(feedAccessOk(req(addr, host), TOKEN), true, `${addr} ${host}`);
  });

  it('token set → loopback socket with a foreign Host (DNS rebinding) is refused', () => {
    assert.equal(feedAccessOk(req('127.0.0.1', 'attacker.example:3117'), TOKEN), false);
    assert.equal(feedAccessOk(req('127.0.0.1', 'localhost.attacker.example'), TOKEN), false);
    assert.equal(feedAccessOk(req('127.0.0.1', undefined), TOKEN), false);
  });

  it('token set → LAN/tailnet need the exact bearer', () => {
    const lan = (auth) => req('192.168.1.176', 'alfred.local:3117', auth);
    assert.equal(feedAccessOk(lan(), TOKEN), false);
    assert.equal(feedAccessOk(lan('Bearer nope'), TOKEN), false);
    assert.equal(feedAccessOk(lan(`Bearer ${TOKEN}x`), TOKEN), false);
    assert.equal(feedAccessOk(lan(TOKEN), TOKEN), false);
    assert.equal(feedAccessOk(lan(`Bearer ${TOKEN}`), TOKEN), true);
    assert.equal(feedAccessOk(req('100.72.7.12', 'localhost:3117', `Bearer ${TOKEN}`), TOKEN), true);
  });

  it('a spoofed loopback Host from a LAN socket is not loopback', () => {
    assert.equal(isLoopbackCaller(req('192.168.1.176', 'localhost:3117')), false);
    assert.equal(feedAccessOk(req('192.168.1.176', 'localhost:3117'), TOKEN), false);
  });
});
