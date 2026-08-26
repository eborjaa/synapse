// core-singleton.test.mjs — US-4.4: exactly one synapse-core per config volume.
//
// Compose enforces this for the happy path (`container_name` + `deploy.replicas: 1` make
// `--scale synapse-core=2` collide on the name). Compose is also trivially bypassed: two
// `node bin/synapse-mcp.mjs --http` against one mounted config volume are two writers against a DB
// whose lease/fence design in spawn.mjs assumes one. These tests are the process-level half of that
// guarantee, and they pin the carve-out too — the raw adapter stays unlocked on purpose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CORE_LOCK_HELD, coreLockPath } from "../lib/core-lock.mjs";
import { toolTransportAdapters } from "../lib/ports/index.mjs";
import { buildServer } from "./build-server.mjs";
import { startHttpServer } from "./http-server.mjs";

/** A throwaway $SYNAPSE_HOME, so no test ever writes a lock into a real config directory. */
function homeSandbox() {
  const home = mkdtempSync(join(tmpdir(), "syn-core-single-"));
  const previous = process.env.SYNAPSE_HOME;
  process.env.SYNAPSE_HOME = home;
  return {
    home,
    clean() {
      if (previous === undefined) delete process.env.SYNAPSE_HOME;
      else process.env.SYNAPSE_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const start = (extra = {}) => startHttpServer({
  host: "127.0.0.1",
  port: 0,
  surface: "skeleton",
  plugins: [],
  log: () => {},
  ...extra,
});

test("US-4.4: a second synapse-core against one config volume is refused, and the live one keeps its socket", async () => {
  const s = homeSandbox();
  let live = null;
  try {
    live = await start();
    assert.ok(existsSync(coreLockPath(s.home)), "starting core takes the lock on $SYNAPSE_HOME");

    await assert.rejects(start(), new RegExp(CORE_LOCK_HELD), "the second core is refused");

    // The point of acquiring BEFORE listen: the refusal must not have disturbed the running server.
    const reply = await fetch(live.url, { method: "GET" });
    assert.notEqual(reply.status, 0);
    await reply.arrayBuffer();
    assert.ok(existsSync(coreLockPath(s.home)), "the refused attempt did not release someone else's lock");
  } finally {
    if (live) await live.close();
    s.clean();
  }
});

test("US-4.4: close() releases, so a restart against the same volume is not an outage", async () => {
  const s = homeSandbox();
  try {
    const first = await start();
    await first.close();
    assert.equal(existsSync(coreLockPath(s.home)), false, "close() removed the lock file");

    const second = await start();
    await second.close();
  } finally {
    s.clean();
  }
});

test("US-4.4: a start that never listens still releases — one bad --host is not a permanent lockout", async () => {
  const s = homeSandbox();
  try {
    await assert.rejects(start({ host: "0.0.0.0" }), /refuses wildcard bind address/);
    assert.equal(existsSync(coreLockPath(s.home)), false, "the failed start left no lock behind");

    const live = await start();
    await live.close();
  } finally {
    s.clean();
  }
});

test("US-4.4: two config volumes are two deployments — each holds its own lock", async () => {
  const a = homeSandbox();
  const first = await start({ home: a.home });
  const b = homeSandbox();
  try {
    const second = await start({ home: b.home });
    assert.ok(existsSync(coreLockPath(a.home)) && existsSync(coreLockPath(b.home)));
    await second.close();
  } finally {
    await first.close();
    b.clean();
    a.clean();
  }
});

test("the raw HTTP adapter stays UNLOCKED — two listeners in one process is a deliberate carve-out", async () => {
  const s = homeSandbox();
  const http = toolTransportAdapters.get("http");
  const opts = { host: "127.0.0.1", port: 0, surface: "skeleton", plugins: [] };
  const first = await http.serve(buildServer, opts);
  try {
    // mcp/http-transport.test.mjs proves vault A / vault B isolation by running two listeners at once.
    // If the lock ever moved down into serve(), that test would fail instead of this one — so pin the
    // boundary here, where the reason is written down.
    const second = await http.serve(buildServer, opts);
    assert.notEqual(first.address.port, second.address.port);
    assert.equal(existsSync(coreLockPath(s.home)), false, "serve() takes no singleton lock");
    await second.close();
  } finally {
    await first.close();
    s.clean();
  }
});
