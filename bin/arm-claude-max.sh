#!/bin/sh
# arm-claude-max.sh — point CRUCIX's idea engine at the Claude Max subscription.
# Run ON THE MINI (needs a browser for the one-time OAuth). It:
#   1. mints a long-lived subscription token (`claude setup-token`, browser click)
#   2. installs the Claude Code CLI on alfred (idempotent)
#   3. writes CLAUDE_CODE_OAUTH_TOKEN + LLM_PROVIDER=claude-cli into alfred's
#      ~/crucix/.env (backing it up first; ollama line kept for manual fallback)
#   4. restarts com.dennis.crucix and tails the next sweep's ideas_source
set -eu

BODY="${BODY:-alfred@alfred}"
MODEL="${LLM_MODEL:-sonnet}"

echo "==> 1/4 minting the subscription token (browser will open — approve it)"
TOKEN="$(claude setup-token | grep -oE 'sk-ant-oat[A-Za-z0-9_-]+' | tail -1)"
[ -n "$TOKEN" ] || { echo "!! no token captured from claude setup-token"; exit 1; }

echo "==> 2/4 installing the Claude Code CLI on the body (idempotent)"
ssh "$BODY" 'command -v claude >/dev/null 2>&1 || /opt/homebrew/bin/npm install -g @anthropic-ai/claude-code >/dev/null'
ssh "$BODY" 'export PATH=/opt/homebrew/bin:$PATH; claude --version'

echo "==> 3/4 wiring alfred's ~/crucix/.env"
ssh "$BODY" "cd ~/crucix && cp .env .env.bak-\$(date +%F) && \
  grep -v -e '^CLAUDE_CODE_OAUTH_TOKEN=' -e '^LLM_PROVIDER=' -e '^LLM_MODEL=' -e '^CLAUDE_BIN=' .env > .env.new && \
  { echo 'LLM_PROVIDER=claude-cli'; echo 'LLM_MODEL=$MODEL'; echo 'CLAUDE_BIN=/opt/homebrew/bin/claude'; \
    echo 'CLAUDE_CODE_OAUTH_TOKEN=$TOKEN'; } >> .env.new && \
  mv .env.new .env && chmod 600 .env"

echo "==> 4/4 restarting CRUCIX and watching for the first claude-powered sweep"
ssh "$BODY" 'launchctl kickstart -k gui/$(id -u)/com.dennis.crucix'
sleep 45
ssh "$BODY" 'curl -s http://127.0.0.1:3117/api/state | python3 -c "import json,sys; s=json.load(sys.stdin); print(\"ideas_source:\", s.get(\"ideas_source\") or s.get(\"ideasSource\"))"' || true
echo "done — ideas_source should read 'llm' on the next completed sweep (they run every 15m)."
