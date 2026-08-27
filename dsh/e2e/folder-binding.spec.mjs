import { test, expect, VAULTS, VAULT_IDS } from './fixtures.mjs';

/**
 * The core claim: Synapse tools follow the OPEN FOLDER.
 *
 * Four DSH sessions, four folders, one shared synapse-core, all four asked AT THE SAME TIME.
 * Each must see its own vault's agents and hubs and none of the other three's.
 *
 * The four vaults are asserted in ONE test rather than four, because "in parallel" is part of
 * the claim: a per-request binding bug is exactly the kind that hides when requests are
 * serialised. Promise.all puts the four turns genuinely in flight together.
 *
 * PROMPT HYGIENE — the rule that keeps these assertions honest: the prompt names TOOLS only.
 * It never names an agent, a hub, or a vault. If an expected token appeared in the prompt, a
 * model that ignored the tool entirely and echoed the question back would still "pass".
 */
const PROMPT = [
  'Call the synapse_list_hubs tool, then call the synapse_list_agents tool.',
  'Quote BOTH raw tool results verbatim in fenced code blocks.',
  'Do not summarise and do not omit any entry.',
].join(' ');

test('four open folders answer from four different vaults, in parallel', async ({ openVaults }) => {
  const sessions = await openVaults(VAULT_IDS);

  const replies = Object.fromEntries(
    await Promise.all(
      VAULT_IDS.map(async (vaultId) => [vaultId, await sessions[vaultId].ask(PROMPT)]),
    ),
  );

  for (const vaultId of VAULT_IDS) {
    const session = sessions[vaultId];
    const answer = replies[vaultId].text;

    // The tools ran and reported success — read off the UI's own tool state, which is the
    // tool's outcome and not the model's account of it.
    for (const tool of ['synapse_list_hubs', 'synapse_list_agents']) {
      const calls = session.callsFor(tool);
      expect(calls.length, `${vaultId} should have called ${tool}`).toBeGreaterThan(0);
      expect(calls.at(-1).state, `${vaultId}'s ${tool} should have succeeded`).toBe('ok');
    }

    const { present, absent } = VAULTS[vaultId];
    for (const token of present) {
      expect(answer, `${vaultId} should see ${token}`).toContain(token);
    }
    for (const token of absent) {
      expect(answer, `${vaultId} must NOT see ${token}`).not.toContain(token);
    }
  }
});
