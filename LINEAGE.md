# LINEAGE — crucix in this house

*House-owned file. `README.md` belongs to upstream; anything we write there fights every
`git merge upstream`. This file is ours and upstream will never touch it.*

## What this repo is here

**A first-class house engine that happens to be a fork.** It serves curated world-state at
read-only `/api/state`, which is what MIDAS's dashboard consumes, and it runs in production
on the alfred body (`com.dennis.crucix` launchd, `/Users/alfred/crucix`).

## Fork lineage

- `origin` → **`skindini/Crucix`** — our fork. `isFork: true`.
- `upstream` → **`calesthio/Crucix`** — the original. AGPLv3.
- Dennis's standing decision (2026-07-13): **keep tracking upstream — do not hard-fork.**

Live code still carries upstream's identity where it should: `lib/llm/openrouter.mjs:21`
sends `HTTP-Referer: https://github.com/calesthio/Crucix`, and `test/llm-openrouter.test.mjs:36`
asserts exactly that. Leave both alone.

## Why it is NOT in `_forks/`

`_forks/` was chartered as *"repos we run but don't own."* By that wording this repo belongs
there. **Dennis restated the charter 2026-09-02: the line is not ownership, it is whether we
BUILD on a repo or merely CONSUME it.** The yard holds upstreams we vendor and layer on
thinly; this is one we actively develop. So it lives at `~/Projects/crucix` like any house
repo, and its lineage is recorded here instead of by its filing location.

A stale duplicate did sit in the yard until 2026-09-02 — 133 commits against this repo's 136,
a strict ancestor with a clean tree. It was verified lossless and moved to
`_attic/crucix-forks-duplicate-2026-09-02/`.

## Naming, so nobody re-litigates it

The GitHub slug is `skindini/Crucix` (capital C). It was **deliberately not renamed** to
lowercase: GitHub resolves owner/repo case-insensitively at the router, so
`https://github.com/skindini/crucix.git` already resolves today and a rename would change
nothing. Verified live with `git ls-remote` before the decision.

The ~3,100 bare `crucix` strings across `alfred/` and `midas/` are the **service name**
(`fetch_crucix()`, `MIDAS_CRUCIX_URL`, `crucix:n/a` grounding labels) — unrelated to the slug.

## Fork-only behaviour to keep out of upstream PRs

- **`lib/access.mjs` — the live-data guard (2026-10-13, audit ss-9cc36e22).** With
  `CRUCIX_EVENTS_TOKEN` set, `/api/data`, `/api/events`, `/api/state` and SSE `/events` need
  `Authorization: Bearer <token>` unless the caller is loopback *and* names a loopback Host.
  The body binds `*:3117` on purpose: midas D30 polls `http://alfred.local:3117/api/events`
  from the mini (sending Keychain `midas-crucix-token`), and every body consumer uses
  `127.0.0.1`. `/`, static files and `/api/health` stay open (cabal doctor probes `/`).
  Never front Crucix with a same-host proxy (`tailscale serve`) while relying on the guard —
  every proxied caller would look loopback.
- **`lib/source-health.mjs` + `GET /api/sources` (2026-10-18).** Each sweep appends one line to
  `runs/source-health.jsonl` (30-day retention), judging every source by its payload: lit,
  nokey, stub or error. `/api/health`'s `sourcesOk` counts a keyless source as ok, which hid eight
  dark sources. `/api/sources` serves state, last lit, and 24h/7d uptime per source, plus sweep
  cadence, behind the same guard. MIDAS's CRUCIX tab ("Data feeds") reads it. `bin/sync-keys.sh`
  (same date) moves source keys from the mini's Keychain into the body's `.env`.
- The dashboard escaping (`escapeData`), `OPEN_BROWSER` and inject's `embedData` are
  upstream-shaped: the three `fix(dashboard): …` commits of 2026-10-13 (5984b40, 745f016, f2adcbb)
  cherry-pick cleanly onto upstream master without the guard (verified) and are the candidate PR.
