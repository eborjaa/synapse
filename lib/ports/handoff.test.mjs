#!/usr/bin/env node
// handoff.test.mjs — codec + port shape. Behavioral close/sweep tests live next to the sqlite
// adapter (lib/durable-spawn/handoff.test.mjs) against a real database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HandoffPort, mintHandle, parseHandle, checksumOf } from "./handoff.mjs";

test("HandoffPort rejects an adapter missing a lifecycle method", () => {
  const incomplete = { id: "x", label: "x", claim() {}, renew() {}, close() {}, sweep() {} };
  assert.throws(() => HandoffPort.assert(incomplete), /openHandoffs/);
});

test("minted handles parse, and a one-character-off handle is invalid-handle", () => {
  for (let i = 0; i < 20; i++) {
    const h = mintHandle();
    assert.match(h, /^[0-9a-hjkmnp-tv-z]{10}-[0-9a-hjkmnp-tv-z]{2}$/);
    assert.equal(parseHandle(h).ok, true);
    assert.equal(parseHandle(h).handle, h);

    const last = h[h.length - 1];
    const alph = "0123456789abcdefghjkmnpqrstvwxyz";
    const flipped = h.slice(0, -1) + alph[(alph.indexOf(last) + 1) % alph.length];
    assert.equal(parseHandle(flipped).ok, false);
    assert.equal(parseHandle(flipped).reason, "invalid-handle");
  }
});

test("checksum is case-insensitive and remaps Crockford confusables", () => {
  const h = mintHandle();
  assert.equal(parseHandle(h.toUpperCase()).handle, h);
  assert.equal(checksumOf(h.slice(0, 10).toUpperCase()), h.slice(-2).toUpperCase());
});

test("malformed strings are invalid-handle, not unknown-handle", () => {
  for (const s of ["", "nope", "abcd", hWithoutChecksum(), "uuid-shaped-00000000-0000-0000-0000-000000000000"]) {
    const r = parseHandle(s);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid-handle", s);
  }
});

function hWithoutChecksum() {
  return mintHandle().slice(0, 10);
}
