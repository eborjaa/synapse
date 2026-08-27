#!/usr/bin/env node
// handoff.mjs — HandoffPort: one lifecycle for a claimed job, identified by one checksummed handle.
//
// WHY THIS PORT EXISTS. Closing a handoff used to ask a model to retype five identifiers
// (job, owner, token, spawnId, episodeId) from an earlier turn. A live run mistyped one character of
// episodeId; the lookup found nothing and gave up, the lease released, and the logbook entry stayed
// open with its summary discarded — while the tool still reported released:true. That is worse than
// no record: an entry stuck open tells every future agent "someone is on this — stand down", forever.
//
// The job name stays (it is the dedup key; a UUID can never collide on purpose). What the model
// carries at close time is a HANDLE the server minted at claim: Crockford base32 with a checksum, so
// a typo is refused as invalid-handle BEFORE any lookup. Ticket and logbook close together; anything
// still open past its ticket expiry is swept to ended-unknown. See [[decision-0019-handoff-identity]].
//
// Nothing in this file names SQLite, MCP, HTTP, or a harness. The sqlite adapter lives in
// lib/durable-spawn/handoff.mjs; the tool adapter (mcp/tools/spawn.mjs) calls the port and must
// contain no table access.
//
// ACCEPTANCE: a mistyped handle can never produce a silent success, and no handoff can remain open
// past its expiry — proven by tests that mutate the handle, not by review.

import { randomBytes } from "node:crypto";
import { definePort } from "./port.mjs";

export const HandoffPort = definePort({
  name: "HandoffPort",
  fields: ["label"],
  methods: ["claim", "renew", "close", "sweep", "openHandoffs"],
  contract:
    "a mistyped handle never produces a silent success; closing is atomic and idempotent; nothing "
    + "stays open past its ticket expiry (swept to ended-unknown).",
});

// Crockford base32 — no I, L, O, U (the characters that get transcribed wrong).
const ALPH = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** CRC-10 (ATM polynomial 0x233). 10 bits → two Crockford chars. Catches single-character substitutions. */
function crc10(payload) {
  let crc = 0;
  for (const ch of payload) {
    const v = ALPH.indexOf(ch);
    if (v < 0) return -1;
    for (let i = 4; i >= 0; i--) {
      const bit = (v >> i) & 1;
      const top = (crc >> 9) & 1;
      crc = (crc << 1) & 0x3ff;
      if (top ^ bit) crc ^= 0x233;
    }
  }
  return crc;
}

export function checksumOf(payload) {
  const crc = crc10(String(payload).toUpperCase());
  if (crc < 0) return null;
  return ALPH[(crc >> 5) & 31] + ALPH[crc & 31];
}

/** Mint a handle: 10 payload chars + hyphen + 2-char checksum, lowercase (e.g. h7k2m9qp4v-c3). */
export function mintHandle() {
  const bytes = randomBytes(8);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  n >>= 14n; // 50 bits → 10 × 5-bit symbols
  let payload = "";
  for (let i = 0; i < 10; i++) {
    payload = ALPH[Number(n & 31n)] + payload;
    n >>= 5n;
  }
  return `${payload}-${checksumOf(payload)}`.toLowerCase();
}

/**
 * Validate a handle BEFORE any lookup. Crockford confusables (I/L→1, O→0) are normalised first.
 * A bad checksum is `invalid-handle`, which is a different answer from `unknown-handle`.
 */
export function parseHandle(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "invalid-handle" };
  const s = raw.trim().toUpperCase().replace(/I/g, "1").replace(/L/g, "1").replace(/O/g, "0");
  const m = s.match(/^([0-9A-HJKMNP-TV-Z]{10})-([0-9A-HJKMNP-TV-Z]{2})$/);
  if (!m) return { ok: false, reason: "invalid-handle" };
  if (checksumOf(m[1]) !== m[2]) return { ok: false, reason: "invalid-handle" };
  return { ok: true, handle: `${m[1]}-${m[2]}`.toLowerCase() };
}
