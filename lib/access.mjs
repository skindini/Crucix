// Bearer guard for the live-data routes (/api/data, /api/events, /api/state, SSE /events).
//
// CRUCIX_EVENTS_TOKEN unset → open (no-op), exactly as before.
// CRUCIX_EVENTS_TOKEN set   → a same-host caller that ALSO names a loopback host
//   (Host: localhost / 127.0.0.1 / [::1]) passes — the local dashboard and same-host
//   pollers need nothing. Everyone else (LAN, tailnet) must send
//   `Authorization: Bearer <token>`.
// The Host check keeps DNS rebinding (attacker.example → 127.0.0.1) out of the
// loopback pass. A same-host reverse proxy (tailscale serve, nginx) makes every
// caller loopback — don't front Crucix with one while relying on this guard.

import { timingSafeEqual } from 'node:crypto';

const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

export function isLoopbackCaller(req) {
  const addr = req.socket?.remoteAddress || '';
  const fromLoopback = addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
  return fromLoopback && LOOPBACK_HOST.test(req.headers?.host || '');
}

function bearerMatches(header, token) {
  const got = Buffer.from(String(header || ''));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function feedAccessOk(req, token = process.env.CRUCIX_EVENTS_TOKEN) {
  if (!token) return true;
  return isLoopbackCaller(req) || bearerMatches(req.headers?.authorization, token);
}
