// Claude CLI Provider — uses a Claude Max subscription via the Claude Code CLI
// Auth: a long-lived OAuth token from `claude setup-token`, supplied as
// CLAUDE_CODE_OAUTH_TOKEN (env or .env). Draws from the subscription pool —
// no API credits involved.
//
// LOAD-BEARING: ANTHROPIC_API_KEY is STRIPPED from the child env. If it leaked
// through it would silently override subscription auth and every sweep would
// bill the API — the exact failure the 2026-07-21 credit death came from.

import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { LLMProvider } from './provider.mjs';

export class ClaudeCLIProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'claude-cli';
    this.model = config.model || 'sonnet';
    this.bin = config.bin || process.env.CLAUDE_BIN || 'claude';
    this.token = config.token || process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
  }

  // A missing token is the one mis-wiring we can detect up front; a missing
  // binary surfaces as a loud spawn error in complete() (fail loud, not quiet).
  get isConfigured() { return !!this.token; }

  async complete(systemPrompt, userMessage, opts = {}) {
    const timeout = opts.timeout || 90000;
    const args = [
      '-p',                              // headless print mode, prompt on stdin
      '--model', this.model,
      '--output-format', 'text',
      '--max-turns', '1',                // one completion — never an agentic loop
    ];
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;        // see header — subscription auth ONLY
    delete env.ANTHROPIC_AUTH_TOKEN;
    env.CLAUDE_CODE_OAUTH_TOKEN = this.token;

    const text = await new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        env,
        cwd: tmpdir(),                   // never inside a repo — no project context
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`claude-cli: timed out after ${timeout}ms`));
      }, timeout);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', e => {
        clearTimeout(timer);
        reject(new Error(`claude-cli: could not run "${this.bin}" (${e.message}). ` +
          'Install the Claude Code CLI (npm i -g @anthropic-ai/claude-code).'));
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`claude-cli exited ${code}: ${(err || out).substring(0, 300)}`));
        } else {
          resolve(out.trim());
        }
      });
      child.stdin.write(userMessage || '');
      child.stdin.end();
    });

    return {
      text,
      usage: { inputTokens: 0, outputTokens: 0 }, // the CLI's text mode reports none
      model: this.model,
    };
  }
}
