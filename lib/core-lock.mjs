// core-lock.mjs — exactly one synapse-core process per SYNAPSE_HOME.
//
// WHY a lock file, not just Docker `container_name`. Compose can be bypassed (`node bin/synapse-mcp.mjs
// --http` twice against the same volumes). The lease/fence design in spawn.mjs assumes one writer per
// vault DB; two HTTP processes on one SYNAPSE_HOME are two writers. Failure mode: two cores accept the
// same credential and interleave episode/lease writes.
//
// The lock lives on the config volume so a second container (or a second host process) sees it.
//
// WHY THE RECORD IS pid + host + startedAt AND NOT JUST pid. `process.kill(pid, 0)` answers "is that
// pid alive IN MY pid namespace", which is only the same question when the writer shared that
// namespace. Two things break a bare pid:
//
//   1. RECYCLED PIDS. A container that is hard-killed leaves the file behind; the restarted core is
//      handed a LOW pid from a fresh namespace and very often the SAME one. It then reads the dead
//      holder's pid, signals it, discovers "itself" alive, and refuses — a permanent crash loop that
//      only ever escapes if a retry happens to drift onto a different pid. Observed, not theorised.
//   2. FOREIGN NAMESPACES. Two containers each have a pid 7. Trusting kill(7,0) there would let a
//      second core STEAL a lock a live core holds — the exact corruption this file exists to prevent.
//
// So liveness is only consulted when the record was written on this host, and a record this process
// did not write but whose pid IS this process's pid is proof of a recycled pid, not of a live holder.
// A record from another host is UNVERIFIABLE, and unverifiable resolves to "refuse and say so"
// ([[rule-synapse-fail-loudly]]) — never to a silent steal. reapForeignHostLock() is the deliberate,
// deployment-scoped escape hatch; see deploy/core-entrypoint.sh for the one place it is sound.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { synapseHome } from "./vaults.mjs";

export const CORE_LOCK_HELD = "another synapse-core is already running against this config volume";
export const CORE_LOCK_FOREIGN =
  "a synapse-core lock on this config volume was written by another machine or container";

/** Lock paths this PROCESS currently holds. The only way to tell "my pid" from "a recycled pid". */
const heldHere = new Set();

export function coreLockPath(home = synapseHome()) {
  return join(home, "synapse-core.lock");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only answer that means "gone". EPERM means a process we may not signal exists,
    // which is still a live holder — never steal on EPERM.
    return error?.code !== "ESRCH";
  }
}

function readLock(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Decide what an existing lock record means, given who is asking.
 * Exported so the table above is testable without staging real processes.
 */
export function classifyLock(existing, { path, host = hostname(), pid = process.pid } = {}) {
  if (!existing || !Number.isInteger(existing.pid)) return { state: "stale", why: "unreadable record" };
  if (path && heldHere.has(path)) return { state: "held", why: "held by this process" };

  // A record with no host predates this format. It can only have come from a plain host install, so
  // read it as local rather than refusing every upgrader.
  const owner = typeof existing.host === "string" && existing.host ? existing.host : host;
  if (owner !== host) return { state: "foreign", why: `written on ${owner}` };

  if (existing.pid === pid) {
    // Same host, our own pid, and we did not write it — the writer is gone and the kernel handed us
    // its number. Signalling it would only ever find ourselves.
    return { state: "stale", why: `pid ${pid} was recycled` };
  }
  return pidAlive(existing.pid)
    ? { state: "held", why: `pid ${existing.pid} is alive` }
    : { state: "stale", why: `pid ${existing.pid} is gone` };
}

/**
 * Take the singleton lock for this SYNAPSE_HOME. Returns a handle whose release() is idempotent.
 * Throws CORE_LOCK_HELD when another live process owns the file, CORE_LOCK_FOREIGN when the record
 * came from a namespace whose liveness this process cannot check.
 */
export function acquireCoreLock(home = synapseHome()) {
  mkdirSync(home, { recursive: true });
  const path = coreLockPath(home);

  const tryCreate = () => {
    const fd = openSync(path, "wx");
    writeSync(fd, `${JSON.stringify({
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    })}\n`);
    heldHere.add(path);
    let released = false;
    return {
      path,
      release() {
        if (released) return;
        released = true;
        heldHere.delete(path);
        try { closeSync(fd); } catch { /* already closed */ }
        try { unlinkSync(path); } catch { /* gone */ }
      },
    };
  };

  try {
    return tryCreate();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const existing = readLock(path);
  const verdict = classifyLock(existing, { path });
  if (verdict.state === "held") {
    throw new Error(`${CORE_LOCK_HELD} (${verdict.why})`);
  }
  if (verdict.state === "foreign") {
    throw new Error(`${CORE_LOCK_FOREIGN} (${verdict.why}); this process cannot verify whether it is still running`);
  }

  try { unlinkSync(path); } catch { /* raced */ }
  try {
    return tryCreate();
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(CORE_LOCK_HELD);
    throw error;
  }
}

/**
 * Clear a lock written by ANOTHER host/container, and report what was cleared.
 *
 * This is unsound in general — the foreign holder may be live — so the library refuses instead. It is
 * sound in exactly one place: a deployment that has already guaranteed singleton-ness at a layer above
 * this one. In the compose stack `container_name: synapse-core` means at most one core container can
 * exist, so a record naming a DIFFERENT container is necessarily a container that is already gone
 * (hard-killed, then recreated with a new id). See deploy/core-entrypoint.sh.
 *
 * Returns the cleared record, or null when there was nothing foreign to clear.
 */
export function reapForeignHostLock(home = synapseHome()) {
  const path = coreLockPath(home);
  const existing = readLock(path);
  if (!existing) return null;
  if (classifyLock(existing, { path }).state !== "foreign") return null;
  try { unlinkSync(path); } catch { return null; }
  return existing;
}
