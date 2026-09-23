// claude-cli provider — timeout tagging (fake binary; no Claude, no network)
// Uses Node.js built-in test runner (node:test) — no extra dependencies

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCLIProvider } from '../lib/llm/claude-cli.mjs';
import { classifyLLMError } from '../lib/llm/ideas.mjs';

const posix = process.platform !== 'win32';

describe('ClaudeCLIProvider timeouts', { skip: !posix && 'needs a POSIX shell for the fake binary' }, () => {
  let dir;
  let slowBin;
  let okBin;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'crucix-claude-cli-'));
    slowBin = join(dir, 'slow-claude');
    // `exec` so the provider's SIGKILL hits the sleeper itself (no orphan holding the pipe)
    writeFileSync(slowBin, '#!/bin/sh\ncat >/dev/null\nexec sleep 5\n');
    chmodSync(slowBin, 0o755);
    okBin = join(dir, 'ok-claude');
    writeFileSync(okBin, '#!/bin/sh\ncat >/dev/null\necho "[]"\n');
    chmodSync(okBin, 0o755);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('rejects with a TimeoutError the ideas layer classifies as timeout', async () => {
    const p = new ClaudeCLIProvider({ bin: slowBin, token: 'test-token' });
    await assert.rejects(p.complete('sys', 'user', { timeout: 200 }), (err) => {
      assert.equal(err.name, 'TimeoutError');
      assert.equal(err.code, 'ETIMEDOUT');
      assert.match(err.message, /timed out after 200ms/);
      assert.equal(classifyLLMError(err), 'timeout');
      return true;
    });
  });

  it('returns stdout when the CLI answers in time', async () => {
    const p = new ClaudeCLIProvider({ bin: okBin, token: 'test-token' });
    const out = await p.complete('sys', 'user', { timeout: 5000 });
    assert.equal(out.text, '[]');
  });
});
