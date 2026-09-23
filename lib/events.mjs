// /api/events payload — the machine-readable idea feed MIDAS polls.
//
// Wire contract (every field additive; nothing existing renamed or removed):
//   {ts, kind: "idea_<type>", payload: {
//     id, ticker, title, confidence, horizon, rationale,   // original fields
//     source,      // "llm" | "rules" — which engine produced the idea
//     risk,        // the idea's key risk (string or null)
//     signals,     // supporting signals (array, possibly empty)
//     first_seen,  // ISO time this idea id was first produced (<= ts)
//   }}
// MIDAS (skindini/midas-v2 src/midas/events.py HttpEventSource._to_event) keeps the
// payload dict whole and dedupes on payload.ticker, then payload.id — so `id` must
// stay byte-identical to the historical formula below.

import { createHash } from 'crypto';

/** Stable idea identity: sha1("type:ticker:title"), first 12 hex chars. */
export function ideaId(idea) {
  return createHash('sha1')
    .update(`${idea.type}:${idea.ticker || ''}:${idea.title}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Which engine produced the idea. Ideas are tagged at birth (parseIdeasResponse →
 * "llm", generateIdeas → "rules"); for an untagged idea fall back to the sweep's
 * ideasSource — only a clean "llm" sweep means the LLM wrote it.
 */
export function ideaSource(idea, ideasSource) {
  if (idea?.source === 'llm' || idea?.source === 'rules') return idea.source;
  return ideasSource === 'llm' ? 'llm' : 'rules';
}

export function buildIdeaEvents(ideas, { ts, ideasSource } = {}) {
  return (ideas || []).map((idea) => ({
    ts,
    kind: `idea_${String(idea.type || 'watch').toLowerCase()}`,
    payload: {
      id: ideaId(idea),
      ticker: idea.ticker,
      title: idea.title,
      confidence: idea.confidence,
      horizon: idea.horizon,
      rationale: idea.rationale || idea.text,
      source: ideaSource(idea, ideasSource),
      risk: idea.risk || null,
      signals: Array.isArray(idea.signals) ? idea.signals : [],
      first_seen: idea.first_seen || ts,
    },
  }));
}
