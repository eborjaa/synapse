// spawn-emit.mjs — the DOER side of durable-spawn: append one progress line to its status file.
//
//   synapse spawn-emit HEARTBEAT <stage> <metric>
//   synapse spawn-emit WAITING   <what>  <etaMinutes>
//   synapse spawn-emit DONE      <summary…>
//   synapse spawn-emit FAILED    <reason…>
//
// Deliberately sqlite-FREE: a doer runs in any runtime (claude/cursor/opencode) via a plain `synapse`
// shell call with no --experimental-sqlite flag, so this must not import node:sqlite. It only appends to
// the status file the launcher put in $SYNAPSE_SPAWN_STATUS. Lease renewal is the ORCHESTRATOR's job
// (synapse_spawn_status renews on a fresh heartbeat) — the doer merely signals progress.

import { heartbeat, waiting, done, failed } from "./durable-spawn/heartbeat.mjs";

const args = process.argv.slice(2);
const kind = (args[0] || "").toUpperCase();
const status = process.env.SYNAPSE_SPAWN_STATUS;

if (!status) {
  console.error("spawn-emit: no $SYNAPSE_SPAWN_STATUS in env — are you running inside a spawned doer?");
  process.exit(2);
}

const iso = new Date().toISOString();
switch (kind) {
  case "HEARTBEAT":
    heartbeat(status, args[1] || "work", args.slice(2).join(" ") || "-", iso);
    break;
  case "WAITING":
    waiting(status, args[1] || "task", Number(args[2] || "5"), iso);
    break;
  case "DONE":
    done(status, args.slice(1).join(" ") || "-", iso);
    break;
  case "FAILED":
    failed(status, args.slice(1).join(" ") || "-", iso);
    break;
  default:
    console.error("spawn-emit: kind must be HEARTBEAT | WAITING | DONE | FAILED");
    process.exit(2);
}
