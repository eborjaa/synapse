// durable-spawn / liveness.mjs
//
// The single sanctioned way to decide a spawned doer's state. It is a PURE
// function over facts the caller supplies; by construction it has no access to
// the `.output` transcript and never takes a file mtime as input. That is the
// structural guarantee that the a9463a07 bug (mtime-as-liveness) cannot recur
// through this path.
//
// Design rules it encodes (from the adversarial review):
//   F1 — death is concluded ONLY from a harness terminal signal or an expired
//        lease. It is never concluded from heartbeat staleness alone (which used
//        to deadlock as "presume alive forever" OR misfire as false death).
//   F2 — a stale heartbeat on a still-leased doer is a HANG SUSPICION that
//        escalates to a human. It is never an auto-death / auto-redispatch.

export const DEFAULT_THRESHOLDS = {
  hangMs: 4 * 60_000, // heartbeat silence beyond this (while leased, not WAITING) => escalate to human
  maxWaitMs: 45 * 60_000, // hard ceiling on any self-reported WAITING/ETA — a huge/hostile ETA
  //                          cannot mask a hang forever; past this we fall through to hang-suspected
};

/**
 * @param {object} facts
 * @param {"running"|"done"|"failed"|"orphaned"} facts.registryState  harness/registry truth
 * @param {boolean} facts.leaseLive           is the job's lease still within TTL
 * @param {"DONE"|"FAILED"|null} facts.terminalMarker   last terminal line in the status file, if any
 * @param {number|null} facts.lastHeartbeatAgeMs        age of the last HEARTBEAT line (null = none yet)
 * @param {{etaMs:number, ageMs:number}|null} facts.waiting  active WAITING window, if the doer declared one
 * @param {object} [thresholds]
 * @returns {{state:string, action:string, reason:string}}
 *   state: alive | waiting | done | failed | orphaned | hang-suspected
 *   action: none | reap-result | re-lease | escalate-human
 */
export function classify(facts, thresholds = DEFAULT_THRESHOLDS) {
  const {
    registryState,
    leaseLive,
    terminalMarker = null,
    lastHeartbeatAgeMs = null,
    waiting = null,
  } = facts;

  // 1. Authoritative completion — harness terminal signal or the doer's own
  //    terminal marker. This is the primary, verified-reliable death/success
  //    channel (M0): while the orchestrator is alive the harness reports it.
  if (registryState === "done" || terminalMarker === "DONE")
    return { state: "done", action: "reap-result", reason: "terminal-signal" };
  if (registryState === "failed" || terminalMarker === "FAILED")
    return { state: "failed", action: "reap-result", reason: "terminal-signal" };

  // 2. Orphaned: the lease has lapsed. This only happens when the owning
  //    orchestrator session died without renewing (the one unsignalled-death
  //    window). Safe to re-lease — fencing (lease.validateFence) rejects any
  //    late zombie write from the old holder.
  if (!leaseLive)
    return { state: "orphaned", action: "re-lease", reason: "lease-expired" };

  // 3. Declared long blocking call: within the doer's own WAITING/ETA window,
  //    silence is expected. Never treated as death — but the honored window is
  //    capped at maxWaitMs so a huge/hostile self-reported ETA cannot mask a
  //    hang forever; past the cap we fall through to step 4 (escalate-human).
  if (waiting && waiting.ageMs <= Math.min(waiting.etaMs, thresholds.maxWaitMs))
    return { state: "waiting", action: "none", reason: "within-declared-eta" };

  // 4. Leased, not WAITING, but heartbeat has gone stale => HANG SUSPICION.
  //    Escalate to a human. Explicitly NOT a death and NOT an auto-redispatch:
  //    a healthy doer stuck in one long tool call (the a9463a07 shape) lands
  //    here, and auto-killing it is exactly the mistake we are removing.
  if (lastHeartbeatAgeMs !== null && lastHeartbeatAgeMs > thresholds.hangMs)
    return { state: "hang-suspected", action: "escalate-human", reason: "heartbeat-stale-while-leased" };

  // 5. Otherwise: leased, fresh (or not yet heartbeated) => presumed alive.
  return { state: "alive", action: "none", reason: "leased-and-fresh" };
}
