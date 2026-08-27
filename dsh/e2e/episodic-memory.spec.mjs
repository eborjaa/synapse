import { test, expect, VAULT_IDS, markerFor, summaryFor } from './fixtures.mjs';

/**
 * Episodic memory is per-vault: what one folder logs, another folder cannot find.
 *
 * WHY THIS IS ONE TEST AND NOT FOUR. The negative half only means something once every
 * marker exists. Split across four tests, "vault A cannot find vault B's marker" would pass
 * trivially whenever A happened to run first — a green suite proving nothing. Seeding all
 * four vaults inside a single test makes the absence real, and makes it order-independent.
 *
 * WHY THE ASSERTION IS NOT `not.toContainText(otherMarker)`. To ask for another vault's
 * marker you must put that marker IN THE PROMPT, and the prompt is on screen. Asserting its
 * absence would fail even on a correct system. So the negative rests on two tokens that
 * appear ONLY in a stored episode and never in any prompt sent to this session:
 *   1. the tool's own empty-result shape, `"episodes": []`
 *   2. the other vault's summary line, which is what a leak would actually drag in
 */
test('episodic memory does not leak between open folders', async ({ openVaults }) => {
  const sessions = await openVaults(VAULT_IDS);

  // --- seed: one distinct episode per vault ---------------------------------
  // Sequential send. Four composers clicking Send at once remount DSH's
  // server-side chrome and the button detaches mid-click. The isolation claim
  // lives in the query rounds below, which stay parallel.
  for (const vaultId of VAULT_IDS) {
    await sessions[vaultId].callTool(
      'synapse_log',
      `Call the synapse_log tool now. Set task to exactly ${markerFor(vaultId)} , ` +
        `set summary to exactly ${summaryFor(vaultId)} , set outcome to done. ` +
        'Then quote the raw tool result verbatim in a fenced code block.',
    );
  }

  // --- each vault finds its OWN episode -------------------------------------
  await Promise.all(
    VAULT_IDS.map(async (vaultId) => {
      const session = sessions[vaultId];
      const reply = await session.callTool(
        'synapse_history',
        `Call the synapse_history tool with query set to exactly ${markerFor(vaultId)} and limit 10. ` +
          'Quote the raw tool result verbatim in a fenced code block, including the count field.',
      );
      // The summary was never in THIS prompt — only in the stored episode. Seeing it echoed
      // back is proof the record was actually retrieved, not reconstructed from the question.
      expect(reply.text, `${vaultId} should find its own episode`).toContain(summaryFor(vaultId));
    }),
  );

  // --- and finds NO other vault's episode ------------------------------------
  // Round-robin: every vault is both a querier and a target, so all four are covered.
  await Promise.all(
    VAULT_IDS.map(async (vaultId, i) => {
      const otherId = VAULT_IDS[(i + 1) % VAULT_IDS.length];
      const session = sessions[vaultId];

      const reply = await session.callTool(
        'synapse_history',
        `Call the synapse_history tool with query set to exactly ${markerFor(otherId)} and limit 10. ` +
          'Quote the raw tool result verbatim in a fenced code block.',
      );

      expect(reply.text, `${vaultId} should find nothing for ${otherId}`)
        .toContain('"episodes": []');
      expect(reply.text, `${vaultId} must not see ${otherId}'s episode body`)
        .not.toContain(summaryFor(otherId));
    }),
  );
});
