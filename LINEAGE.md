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
