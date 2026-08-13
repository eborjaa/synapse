# durable-spawn

Enforced-code fix for the a9463a07 incident: an orchestrator judged a live ~27-min doer dead by its
transcript file's modified time, re-dispatched a duplicate, and the duplicate corrupted rt01. See the
rule `rules/rule-durable-spawn.md` and the RCA `inbox/notes/2026-07-31-qa-lead-orchestration-reliability-rca.md`.

## Modules
- **`lease.mjs`** — dedup lease + monotonic fencing tokens over SQLite (`BEGIN IMMEDIATE`, cross-process).
  `acquire` refuses any live lease; `renew` extends (token required); `validateFence` gates a write on
  current-token-AND-live-lease; `withFence` runs check+mutation in one transaction for a same-DB
  resource; `dbNow` is the single time authority (omit `now` in production).
- **`registry.mjs`** — durable spawn records; `staleSpawns(epoch)` reconciles a restarted orchestrator's
  in-flight jobs (epoch must be a strong unique id).
- **`liveness.mjs`** — pure classifier. Death only from a harness terminal signal or expired lease;
  a stale heartbeat on a live lease is `hang-suspected → escalate-human`, never death. No `.output`/mtime input.
- **`heartbeat.mjs`** — doer emit (`HEARTBEAT`/`WAITING`/`DONE`/`FAILED`) + orchestrator parse that feeds `liveness.classify`.
- **`lint.mjs`** — `scanText` bans "judge liveness by the transcript's modified time" phrasing in briefings/rules.

## Preconditions (a wrong value silently defeats the guarantees)
`owner` unique per doer instance · omit `now` in production (DB clock) · `epoch` a strong unique id ·
treat any thrown `acquire`/`renew` exception as *not acquired* (fail closed). Full statement: `rule-durable-spawn.md`.

## Run
```bash
node --experimental-sqlite --test _meta/mcp/src/tools/durable-spawn/*.test.mjs   # unit (37)
node --experimental-sqlite _meta/mcp/scripts/durable-spawn-e2e.mjs               # e2e (reproduces a9463a07)
node _meta/mcp/scripts/durable-spawn-lint.mjs [path ...]                          # anti-pattern lint (defaults to rules/ + agents/)
```

## CI / pre-commit
The anti-pattern lint is wired into the vault's canonical lint (`_meta/tools/lint.mjs`), so
`node _meta/tools/lint.mjs --strict` (CI) fails any briefing/rule that reinstates
liveness-by-transcript-mtime. To also gate the durable-spawn unit tests + e2e, add the two `node`
commands above to the CI job (the e2e spawns processes, so prefer CI over a fast pre-commit hook).
