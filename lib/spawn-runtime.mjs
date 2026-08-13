// spawn-runtime.mjs — render a briefing and launch a DETACHED, durable doer, CLI-agnostic.
//
// This is the launch half of durable-spawn. The dedup/liveness half lives in lib/durable-spawn/.
// The doer runs as a background process that OUTLIVES the MCP tool call (detached + unref), reporting
// progress to a STATUS FILE via `synapse spawn-emit` (see bin/synapse.mjs). A shell wrapper emits a
// terminal DONE/FAILED on process exit as a backstop — never trust the model to always emit its own.
//
// The per-CLI invocations mirror agents.sh's sink layer, but in non-interactive ("headless") mode so a
// background doer runs to completion and exits. `buildDoerArgv` is a pure function (unit-tested); only
// `launchDetached` touches the process table.

import { spawn } from "node:child_process";
import { openSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SYNAPSE_BIN = fileURLToPath(new URL("../bin/synapse.mjs", import.meta.url));

/** POSIX single-quote a string so it is safe to embed in the wrapper shell script. */
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * The instruction block prepended to a doer's briefing so it self-reports progress. The doer only ever
 * needs ONE command shape — `synapse spawn-emit …` — because owner/token/job/db/status ride in env that
 * the wrapper sets (below). A HEARTBEAT also renews the lease, so a live doer holds its claim.
 */
export function heartbeatPreamble() {
  return [
    "## Durable-spawn protocol (you are a background doer)",
    "",
    "You were launched as a durable background agent. Report progress so the orchestrator can tell you",
    "apart from a hang — run these as shell commands. `$SYNAPSE_SPAWN_EMIT` is preset in your environment",
    "(an absolute path, resolvable from any shell); use it verbatim:",
    "",
    "- Every few minutes, or when you finish a step:  `$SYNAPSE_SPAWN_EMIT HEARTBEAT <stage> <metric>`",
    "  (the orchestrator renews your claim when it sees this — go quiet too long and it will flag a hang).",
    "- Before a long, quiet operation (a test run, a build):  `$SYNAPSE_SPAWN_EMIT WAITING <what> <etaMinutes>`",
    "- On success:  `$SYNAPSE_SPAWN_EMIT DONE <one-line summary>`   ·   On failure:  `$SYNAPSE_SPAWN_EMIT FAILED <reason>`",
    "",
    "Never judge your own liveness by a file's modified time. Do the task in the briefing below.",
    "",
    "---",
    "",
  ].join("\n");
}

/**
 * Render a doer's briefing to text via the package CLI (same engine agents.sh uses).
 * `runSynapse` is injected (from mcp/vault.mjs) so this stays testable.
 * Returns { ok, briefing } | { ok:false, error }.
 */
export async function renderBriefing(runSynapse, { agent, target, task, profile = "standard" }) {
  const useAugment = Boolean(task);
  const base = useAugment ? ["augment"] : ["render"];
  const args = [...base, agent, ...(target ? [target] : []), "--profile", profile];
  if (useAugment) args.push("--task", task);
  const res = await runSynapse(args, { timeoutMs: 120_000 });
  if (res.code !== 0) return { ok: false, error: res.stderr?.trim() || res.stdout?.trim() || `render exit ${res.code}` };
  return { ok: true, briefing: res.stdout };
}

/**
 * Pure: compute the runtime binary + argv for a detached doer. Mirrors agents.sh per-CLI forms in
 * NON-INTERACTIVE mode. For cursor, the briefing rides in a `.cursor/rules` file, so this also returns
 * `prep` (a file to write before launch) instead of a system-prompt flag. Throws on an unknown cli.
 */
export function buildDoerArgv({ cli, briefingFile, vault, model, permMode = "auto", cwd }) {
  const perm = (map) => (map[permMode] ? map[permMode] : []);
  // promptMode says how the wrapper feeds the TASK to the runtime:
  //   "stdin" → piped on stdin (claude --print);  "arg" → a final quoted positional (cursor/opencode).
  switch (cli) {
    case "claude": {
      const args = [
        ...perm({ auto: ["--permission-mode", "acceptEdits"], bypass: ["--permission-mode", "bypassPermissions"], manual: [] }),
        "--print", // headless — reads the prompt from stdin, runs the loop, exits
        "--append-system-prompt-file", briefingFile,
        "--add-dir", vault,
        ...(model ? ["--model", model] : []),
      ];
      return { bin: "claude", args, prep: null, promptMode: "stdin" };
    }
    case "cursor": {
      const rulesFile = join(cwd || vault, ".cursor", "rules", ".synapse-spawn-briefing.mdc");
      const args = [
        "-p", // print / non-interactive; the prompt is a trailing positional
        ...perm({ auto: ["--force"], bypass: ["--force"], manual: [] }),
        ...(model ? ["--model", model] : []),
      ];
      return { bin: "cursor-agent", args, prep: { file: rulesFile, briefingFile, framed: true }, promptMode: "arg" };
    }
    case "opencode": {
      const args = ["run", ...(model ? ["-m", model] : []), "--dir", vault, "--file", briefingFile];
      return { bin: "opencode", args, prep: null, promptMode: "arg" };
    }
    default:
      throw new Error(`buildDoerArgv: unsupported cli '${cli}' (use claude|cursor|opencode)`);
  }
}

/**
 * Launch a detached, durable doer. Writes the briefing (+ preamble), performs any per-CLI prep, then
 * spawns a shell WRAPPER that runs the runtime and emits a terminal DONE/FAILED. Returns { pid }.
 *
 * `env` gets the SYNAPSE_SPAWN_* context so the doer's `spawn-emit` needs no arguments beyond the kind.
 */
export function launchDetached({
  cli, briefing, task, statusFile, logFile, vault, model, permMode,
  job, owner, token, dbPath, cwd,
}) {
  const runDir = dirname(statusFile);
  mkdirSync(runDir, { recursive: true });

  // 1. Briefing file = preamble + rendered briefing.
  const briefingFile = `${statusFile}.briefing.md`;
  writeFileSync(briefingFile, heartbeatPreamble() + briefing, "utf8");

  // 2. Per-CLI argv + prep. The TASK goes to a file and is fed to the runtime per promptMode (stdin for
  //    claude --print, a trailing positional for cursor/opencode) — no task text is quoted into argv.
  const { bin, args, prep, promptMode } = buildDoerArgv({ cli, briefingFile, vault, model, permMode, cwd });
  const taskFile = `${statusFile}.task.txt`;
  writeFileSync(taskFile, task ?? "", "utf8");
  if (prep?.file) {
    mkdirSync(dirname(prep.file), { recursive: true });
    const framed = "---\ndescription: Synapse durable-spawn briefing\nalwaysApply: true\n---\n\n" + heartbeatPreamble() + briefing;
    writeFileSync(prep.file, framed, "utf8");
  }

  // 3. Wrapper script: export context, run the runtime, emit the terminal line. Written to a file to
  //    avoid quoting the runtime argv through `sh -c`.
  const wrapper = `${statusFile}.run.sh`;
  const exports = [
    ["SYNAPSE_VAULT", vault],
    ["SYNAPSE_SPAWN_STATUS", statusFile],
    ["SYNAPSE_SPAWN_JOB", job],
    ["SYNAPSE_SPAWN_OWNER", owner],
    ["SYNAPSE_SPAWN_TOKEN", String(token)],
    ["SYNAPSE_SPAWN_DB", dbPath],
  ].map(([k, v]) => `export ${k}=${shq(v)}`).join("\n")
    // The doer reports progress via $SYNAPSE_SPAWN_EMIT — an absolute `node <bin> spawn-emit` that
    // resolves from any shell, so it never depends on a `synapse` alias/function being loaded.
    + `\nexport SYNAPSE_SPAWN_EMIT=${shq(`${process.execPath} ${SYNAPSE_BIN} spawn-emit`)}`;
  const argvCmd = [shq(bin), ...args.map(shq)].join(" ");
  const runtimeCmd = promptMode === "stdin"
    ? `${argvCmd} < ${shq(taskFile)}`
    : `${argvCmd} "$(cat ${shq(taskFile)})"`;
  const emit = (kind, msg) => `node ${shq(SYNAPSE_BIN)} spawn-emit ${kind} ${shq(msg)}`;
  const script = [
    "#!/bin/sh",
    exports,
    `cd ${shq(cwd || vault)} || exit 1`,
    runtimeCmd,
    "rc=$?",
    `if [ "$rc" -eq 0 ]; then ${emit("DONE", "runtime exited 0")}; else ${emit("FAILED", "runtime exited")} " (rc=$rc)"; fi`,
    "exit $rc",
  ].join("\n") + "\n";
  writeFileSync(wrapper, script, "utf8");
  chmodSync(wrapper, 0o755);

  // 4. Spawn detached; route the runtime's stdio to the log file so the process needs no live parent.
  const out = openSync(logFile, "a");
  const child = spawn("sh", [wrapper], {
    cwd: cwd || vault,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, SYNAPSE_VAULT: vault },
  });
  child.unref();
  return { pid: child.pid };
}
