#!/usr/bin/env node
// port.mjs — the tiny core of Synapse's ports-and-adapters boundary.
//
// A PORT is an interface the core depends on. An ADAPTER is one harness's implementation of it. The
// core imports ports; it never imports or names a harness. That inversion is the whole point: today
// four different places independently re-implement "publish this vault's roster to a tool"
// ([[decision-0011-generated-harness-skills]] tabulates them), and adding a fifth harness means editing
// every one of them. With a port it is one new adapter file and zero core edits.
//
// WHY THIS FILE IS SO SMALL. A port here is a plain object with named functions, checked shallowly at
// registration time. There is no class hierarchy, no DI container and no runtime dispatch magic,
// because none of those would catch the failure that actually happens: an adapter that silently lacks a
// method the core calls six months later. `definePort` + `assertImplements` catch exactly that, at
// import time, with a message naming the port and the missing member — and cost nothing else.
//
// WHY SHAPE-CHECKING IS NOT THE REAL GUARANTEE. Method presence is necessary and nowhere near
// sufficient: the interesting contracts here are behavioral ("targets() writes nothing", "a
// hand-authored file is never overwritten", "a re-run never downgrades a surface"). Those live in the
// per-port CONTRACT TEST, which every adapter is run through. `assertImplements` only guarantees the
// call will not throw TypeError; the contract test is what guarantees the adapter is correct.
// Both exist on purpose — see lib/ports/*.test.mjs.
//
// Zero dependencies. Pure. Importing this file starts nothing.

/**
 * Declare a port: a name, the members every adapter must provide, and a one-line contract statement
 * that is printed when an adapter fails the check (so the error explains the RULE, not just the gap).
 *
 * @param {object} spec
 * @param {string} spec.name      — the port's name, e.g. "ClientConfigPort".
 * @param {string[]} spec.methods — member names every adapter must define as functions.
 * @param {string[]} [spec.fields]— member names every adapter must define as non-function values.
 * @param {string} spec.contract  — one sentence stating the behavioral promise adapters must keep.
 */
export function definePort({ name, methods = [], fields = [], contract }) {
  if (!name) throw new Error("definePort: a port needs a name");
  if (!contract) throw new Error(`definePort(${name}): a port needs a one-line contract statement`);
  const port = {
    name,
    methods: Object.freeze([...methods]),
    fields: Object.freeze([...fields]),
    contract,
    /** Throw unless `adapter` provides every declared member with the right shape. */
    assert(adapter) { return assertImplements(port, adapter); },
    /** Check + return the adapter, so a registry can be written as one expression. */
    register(adapter) { assertImplements(port, adapter); return adapter; },
  };
  return Object.freeze(port);
}

/**
 * Verify one adapter against one port. Throws an Error naming the port, the adapter, the missing or
 * mis-typed member, and the port's contract — fail loudly, with enough context to fix it in one edit
 * ([[rule-synapse-fail-loudly]]).
 */
export function assertImplements(port, adapter) {
  const who = adapter?.id ? `${adapter.id}` : "(anonymous adapter)";
  const fail = (msg) => {
    throw new Error(`${port.name}: adapter ${who} ${msg}\n  contract: ${port.contract}`);
  };
  if (!adapter || typeof adapter !== "object") fail("is not an object");
  if (typeof adapter.id !== "string" || !adapter.id) fail("must expose a non-empty string `id`");
  for (const m of port.methods) {
    if (typeof adapter[m] !== "function") fail(`is missing method \`${m}()\``);
  }
  for (const f of port.fields) {
    if (adapter[f] === undefined) fail(`is missing field \`${f}\``);
    if (typeof adapter[f] === "function") fail(`declares \`${f}\` as a function; it must be a value`);
  }
  return adapter;
}

/**
 * Build an id-keyed registry from a list of adapters, asserting each against the port. Duplicate ids
 * are a hard error rather than a silent overwrite: two adapters answering to one name is precisely the
 * bug this layer exists to prevent, and the DSH MCP client already fails a duplicate `serverName` at
 * plugin load for the same reason ([[note-dsh-extension-seams]]).
 */
export function registry(port, adapters) {
  const byId = new Map();
  for (const a of adapters) {
    port.assert(a);
    if (byId.has(a.id)) {
      throw new Error(`${port.name}: duplicate adapter id "${a.id}" — ids must be unique within a port`);
    }
    byId.set(a.id, a);
  }
  return {
    port,
    ids: () => [...byId.keys()],
    all: () => [...byId.values()],
    has: (id) => byId.has(id),
    /** Look up by id, or throw naming what IS available — never return undefined for a typo. */
    get(id) {
      const a = byId.get(id);
      if (!a) throw new Error(`${port.name}: no adapter "${id}" (have: ${[...byId.keys()].join(", ")})`);
      return a;
    },
    /** Adapters selected by id, or every adapter when `id` is "all". */
    select(id) {
      return id === "all" ? [...byId.values()] : [this.get(id)];
    },
  };
}
