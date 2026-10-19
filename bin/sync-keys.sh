#!/bin/sh
# sync-keys.sh — push CRUCIX's free source API keys from the MINI's Keychain into the
# body's ~/crucix/.env, restart CRUCIX if anything changed, and print each source's status.
# Run ON THE MINI. Idempotent: re-running with nothing new changes nothing and restarts nothing.
#
#   bin/sync-keys.sh            sync, restart if changed, then show source status
#   bin/sync-keys.sh --status   show source status only (reads ~/crucix/runs/latest.json)
#
# To light a source: register (links in .env.example), then store the key on the mini, e.g.
#   security add-generic-password -a "$USER" -s eia-api-key -w      (prompts; nothing in history)
# and re-run this script. Values never touch argv or stdout — they travel over ssh stdin.
set -eu

BODY="${BODY:-alfred@alfred}"

# ENV_VAR:keychain-service — the one map from Keychain items to CRUCIX's env names.
MAP="
FRED_API_KEY:fred-api-key
EIA_API_KEY:eia-api-key
FIRMS_MAP_KEY:firms-map-key
CLOUDFLARE_API_TOKEN:crucix-cloudflare-radar-token
AISSTREAM_API_KEY:aisstream-api-key
ACLED_EMAIL:acled-email
ACLED_PASSWORD:acled-password
REDDIT_CLIENT_ID:reddit-client-id
REDDIT_CLIENT_SECRET:reddit-client-secret
ADSB_API_KEY:adsb-api-key
"

status() {
  ssh "$BODY" 'python3 - ~/crucix/runs/latest.json' <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
src = d.get("sources") or {}
dark = []
for name, v in sorted(src.items()):
    if not isinstance(v, dict):
        continue
    s = v.get("status") or v.get("error") or "ok"
    if s not in ("ok", "active"):
        dark.append(name)
    print(f"  {name:<18} {str(s)[:70]}")
ts = (d.get("crucix") or {}).get("timestamp") or "?"
print(f"sweep {ts} · {len(src) - len(dark)}/{len(src)} sources fully lit · dark: {', '.join(dark) or 'none'}")
PY
}

if [ "${1:-}" = "--status" ]; then status; exit 0; fi

PAYLOAD=""
FOUND=""
for pair in $MAP; do
  var="${pair%%:*}"; svc="${pair#*:}"
  if val="$(security find-generic-password -s "$svc" -w 2>/dev/null)" && [ -n "$val" ]; then
    PAYLOAD="${PAYLOAD}${var}=${val}
"
    FOUND="$FOUND $var"
  fi
done
echo "==> keys found in the mini's Keychain:${FOUND:- none}"
[ -n "$PAYLOAD" ] || { echo "nothing to sync"; status; exit 0; }

CHANGED="$(printf '%s' "$PAYLOAD" | ssh "$BODY" 'python3 -c "
import os, sys, shutil, datetime
path = os.path.expanduser(\"~/crucix/.env\")
new = dict(l.split(\"=\", 1) for l in sys.stdin.read().splitlines() if \"=\" in l)
lines = open(path).read().splitlines() if os.path.exists(path) else []
have = {l.split(\"=\", 1)[0]: l.split(\"=\", 1)[1] for l in lines if \"=\" in l and not l.startswith(\"#\")}
changed = [k for k, v in new.items() if have.get(k) != v]
if changed:
    shutil.copy2(path, path + \".bak-\" + datetime.date.today().isoformat())
    out = [l for l in lines if l.split(\"=\", 1)[0] not in new]
    out += [k + \"=\" + v for k, v in new.items()]
    open(path, \"w\").write(\"\\n\".join(out) + \"\\n\")
    os.chmod(path, 0o600)
print(\" \".join(changed))
"')"

if [ -z "$CHANGED" ]; then
  echo "==> body .env already current — no restart"
  status; exit 0
fi

echo "==> updated on the body: $CHANGED — restarting com.dennis.crucix"
ssh "$BODY" 'launchctl kickstart -k gui/$(id -u)/com.dennis.crucix'
echo "==> waiting for the startup sweep to finish (up to 5 min)"
i=0
while [ $i -lt 30 ]; do
  sleep 10; i=$((i + 1))
  busy="$(ssh "$BODY" 'curl -s -m 5 http://127.0.0.1:3117/api/health' | python3 -c 'import json,sys
try: h=json.load(sys.stdin); print("1" if h.get("sweepInProgress") or not h.get("lastSweep") else "0")
except Exception: print("1")')"
  [ "$busy" = "0" ] && [ $i -ge 3 ] && break
done
status
