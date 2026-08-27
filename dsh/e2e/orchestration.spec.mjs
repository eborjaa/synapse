import { test, expect, RUN_ID } from './fixtures.mjs';

/**
 * The lease lifecycle, per vault: claim → a duplicate claim is HELD → renew → release →
 * the episode closes with outcome=done.
 *
 * synapse_spawn is DELIBERATELY not exercised. It launches a detached CLI (cursor / claude /
 * opencode) inside the DSH container, which is neither installed there nor something a test
 * should leave running. synapse_claim_and_brief covers the same lease machinery and hands the
 * launch back to the caller, so it is the honest surface to test here.
 */
const CASES = [
  { vaultId: 'synapse-vault', agent: 'oracle', target: 'hub-synapse' },
  { vaultId: 'arch-vault', agent: 'architect', target: 'hub-project' },
];

for (const { vaultId, agent, target } of CASES) {
  test(`${vaultId}: claim → held → renew → release`, async ({ openVaults }) => {
    const { [vaultId]: session } = await openVaults([vaultId]);
    // A canonical job id built from stable facts, never from prose — plus the run id, so a
    // re-run claims a genuinely new job instead of colliding with a released one.
    const job = `${agent}:E2E-PW:orch:${RUN_ID}`;

    // 1. Claim. The reply carries the lease header the later steps need.
    let reply = await session.callTool(
      'synapse_claim_and_brief',
      `Call the synapse_claim_and_brief tool with agent set to ${agent} , job set to ${job} , ` +
        `target set to ${target} , profile set to lean , and task set to verify open folder binding. ` +
        'Then reply with ONLY the lease header fields from the raw tool result (job, handle, and whether ' +
        'the claim succeeded) in a fenced code block. ' +
        'Do NOT paste the briefing body.',
    );
    expect(reply.text).toContain(job);
    expect(reply.text).toMatch(/handle[:\s"]+[0-9a-hjkmnp-tv-z]{10}-[0-9a-hjkmnp-tv-z]{2}/i);

    // 2. The same job claimed twice must be REFUSED, not silently duplicated. This is the
    //    property the lease exists for: two phrasings of one task must not both run.
    reply = await session.callTool(
      'synapse_claim_and_brief',
      'Now call the synapse_claim_and_brief tool AGAIN with exactly the same arguments as before. ' +
        'Quote the raw tool result verbatim in a fenced code block. Do not paste any briefing body.',
    );
    expect(reply.text, 'a duplicate claim must be refused as held')
      .toContain('"refused": "held"');

    // 3. Renew — the orchestrator holding a claim across a gap.
    reply = await session.callTool(
      'synapse_spawn_renew',
      `Call the synapse_spawn_renew tool with handle set to the handle returned by the FIRST claim. ` +
        'Quote the raw tool result verbatim in a fenced code block.',
    );
    expect(reply.text).toContain('"ok": true');

    // 4. Release. Leaving a lease hanging would poison the next run of this suite.
    reply = await session.callTool(
      'synapse_spawn_release',
      'Call the synapse_spawn_release tool with handle set to that same handle, ' +
        'outcome set to done and summary set to DSH open-folder e2e orchestration check. ' +
        'Quote the raw tool result verbatim in a fenced code block.',
    );
    expect(reply.text).toMatch(/"closed"\s*:\s*true|closed[:\s]+true/i);

    // 5. The episode is closed and findable — the lease and the memory agree.
    reply = await session.callTool(
      'synapse_history',
      `Call the synapse_history tool with query set to exactly ${job} and limit 5. ` +
        'Quote the raw tool result verbatim in a fenced code block, including every outcome field.',
    );
    expect(reply.text).toContain('"outcome": "done"');
    expect(reply.text).toContain(`"job": "${job}"`);
  });
}

/**
 * Authoring tools propose by default. Omitting `write` must render the file and change
 * nothing on disk — the human-gated path the vault's whole authoring model rests on.
 */
test('univa: authoring tools propose, they do not write', async ({ openVaults }) => {
  const { univa: session } = await openVaults(['univa']);

  const reply = await session.callTool(
    'synapse_create_note',
    `Call the synapse_create_note tool to PROPOSE a note titled DSH open folder e2e probe ${RUN_ID} ` +
      'with a one line body, in hub-iot. Do NOT set the write parameter — leave it omitted so ' +
      'nothing is written to disk. Quote the raw tool result verbatim in a fenced code block.',
  );

  expect(reply.text).toMatch(/PROPOSED \(nothing written\)/);
});
