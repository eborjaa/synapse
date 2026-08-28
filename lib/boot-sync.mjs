#!/usr/bin/env node
// boot-sync.mjs — on synapse-core start, regenerate every registered vault's DSH roster and
// `/synapse-<agent>` skill files onto the shared volumes.
//
// WHY HERE AND NOT BY HAND. A new stack (or a recreate) should come up already wired. The vaults
// live on a named volume both containers see; these commands only WRITE the generated files onto
// that volume. Core is the process that already has the `synapse` CLI and the registry.
//
// Never blocks the HTTP server: a missing vault, a corrupt skill, or an empty registry logs and
// continues. Hand-authored SKILL.md files are kept (same rule as `synapse skills`).

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { applySkillTargets, buildSkillTargets } from "./skills.mjs";
import { applyRosters, planRosters, readRegistry, writeVaultIndex } from "./vaults.mjs";

const line = (s) => process.stderr.write(`${s}\n`);

/**
 * @param {{ log?: (s: string) => void }} [opts]
 * @returns {{ vaults: number, rosterWritten: number, skillsWritten: number, errors: string[] }}
 */
export function bootSync({ log = line } = {}) {
  const result = { vaults: 0, rosterWritten: 0, skillsWritten: 0, errors: [] };

  let reg;
  try {
    reg = readRegistry();
  } catch (e) {
    const msg = `cannot read registry (${e.message})`;
    result.errors.push(msg);
    log(`[synapse-core] boot-sync: ${msg} — starting anyway`);
    return result;
  }

  result.vaults = (reg.vaults || []).length;
  if (!result.vaults) {
    log("[synapse-core] boot-sync: no vaults registered — skip");
    return result;
  }

  try { writeVaultIndex(reg); } catch (e) {
    result.errors.push(`index: ${e.message}`);
    log(`[synapse-core] boot-sync: could not write vault index (${e.message})`);
  }

  try {
    const plans = planRosters({ reg });
    const rows = applyRosters(plans, { write: true, log: () => {} });
    for (const r of rows) {
      if (r.skipped) continue;
      result.rosterWritten += (r.rows || []).filter((x) =>
        x.status === "created" || x.status === "updated" || x.status === "overwritten",
      ).length;
    }
  } catch (e) {
    result.errors.push(`roster: ${e.message}`);
    log(`[synapse-core] boot-sync: roster failed (${e.message}) — continuing`);
  }

  for (const v of reg.vaults) {
    if (!existsSync(v.root)) {
      result.errors.push(`${v.id}: root missing`);
      log(`[synapse-core] boot-sync: ${v.id} root missing (${v.root}) — skip`);
      continue;
    }
    try {
      const { targets } = buildSkillTargets({ root: v.root, vaultDir: v.vaultDir || v.root });
      const rows = applySkillTargets(targets, { root: v.root, write: true });
      result.skillsWritten += rows.filter((x) =>
        x.status === "created" || x.status === "updated" || x.status === "overwritten",
      ).length;
    } catch (e) {
      result.errors.push(`${v.id}: ${e.message}`);
      log(`[synapse-core] boot-sync: ${v.id} skills failed (${e.message}) — skip`);
    }
  }

  log(
    `[synapse-core] boot-sync: ${result.vaults} vault(s) · `
    + `${result.rosterWritten} roster file(s) · ${result.skillsWritten} skill file(s)`
    + (result.errors.length ? ` · ${result.errors.length} issue(s)` : ""),
  );
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  bootSync();
}
