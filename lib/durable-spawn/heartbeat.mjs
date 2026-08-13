// durable-spawn / heartbeat.mjs
//
// The doer side of the protocol (emit) plus the orchestrator side (parse). A
// doer appends structured lines to a dedicated STATUS FILE — never the `.output`
// transcript — and the orchestrator Monitors + parses that file.
//
// This is the PROGRESS / hang-escalation channel. It is deliberately NOT a death
// signal: parseStatus() feeds liveness.classify(), which only ever turns stale
// heartbeats into `hang-suspected → escalate-human`, never death. Death rides
// the harness terminal notification / lease expiry (see liveness.mjs).
//
// Line grammar (one per line, space-delimited, newline-terminated):
//   HEARTBEAT <iso8601> <stage> <metric>
//   WAITING   <iso8601> <task> <etaMinutes>
//   DONE      <iso8601> <summary...>
//   FAILED    <iso8601> <reason...>

import { appendFileSync } from "node:fs";

// O_APPEND writes of a single short line are atomic on POSIX, so a Monitor tail
// and the parser never see a torn line. Always newline-terminated.
function emit(statusFile, kind, iso, rest) {
  appendFileSync(statusFile, `${kind} ${iso} ${rest}\n`, "utf8");
}

export function heartbeat(statusFile, stage, metric, iso = new Date().toISOString()) {
  emit(statusFile, "HEARTBEAT", iso, `${stage} ${metric}`);
}
export function waiting(statusFile, task, etaMinutes, iso = new Date().toISOString()) {
  emit(statusFile, "WAITING", iso, `${task} ${etaMinutes}`);
}
export function done(statusFile, summary, iso = new Date().toISOString()) {
  emit(statusFile, "DONE", iso, summary);
}
export function failed(statusFile, reason, iso = new Date().toISOString()) {
  emit(statusFile, "FAILED", iso, reason);
}

/**
 * Parse a status file's text into the fact shape liveness.classify() consumes.
 * Tolerant: unparseable / partial lines are skipped. `nowMs` is injected.
 * Returns { terminalMarker, lastHeartbeatAgeMs, waiting } where:
 *  - terminalMarker: "DONE" | "FAILED" | null (last terminal line wins)
 *  - lastHeartbeatAgeMs: age of the most recent HEARTBEAT, or null if none
 *  - waiting: { etaMs, ageMs } from the most recent still-open WAITING, or null
 *    (a later HEARTBEAT/DONE/FAILED closes an earlier WAITING)
 */
export function parseStatus(text, nowMs) {
  let terminalMarker = null;
  let lastHeartbeatMs = null;
  let waitingLine = null; // { atMs, etaMs }
  for (const raw of text.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const [kind, iso] = parts;
    const atMs = Date.parse(iso);
    if (Number.isNaN(atMs)) continue;
    switch (kind) {
      case "HEARTBEAT":
        lastHeartbeatMs = atMs;
        waitingLine = null; // progress resumed → close any open WAITING
        break;
      case "WAITING": {
        const etaMin = Number(parts[3]);
        if (Number.isFinite(etaMin)) waitingLine = { atMs, etaMs: etaMin * 60_000 };
        break;
      }
      case "DONE":
        terminalMarker = "DONE";
        waitingLine = null;
        break;
      case "FAILED":
        terminalMarker = "FAILED";
        waitingLine = null;
        break;
      default:
        break; // unknown line kind → ignore
    }
  }
  return {
    terminalMarker,
    lastHeartbeatAgeMs: lastHeartbeatMs === null ? null : nowMs - lastHeartbeatMs,
    waiting: waitingLine ? { etaMs: waitingLine.etaMs, ageMs: nowMs - waitingLine.atMs } : null,
  };
}
