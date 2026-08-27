import { test, expect, RUN_ID } from './fixtures.mjs';

/**
 * Delegation, end to end: one human-shaped ask that needs two doers.
 *
 * This is the case the other specs do NOT cover. `orchestration.spec.mjs` proves the LEASE
 * (claim → held → renew → release) but never launches anybody and explicitly tells the model
 * not to paste the briefing, so it never shows that a briefing is worth having. Here two real
 * DSH subagents run, each on a briefing `synapse_claim_and_brief` produced.
 *
 * The prompt names the two hubs and says "two subagents" out loud, because that is how a person
 * would ask for it and DSH does not infer delegation on its own. It deliberately does NOT name
 * synapse_claim_and_brief — "claim its job with synapse and get that agent its briefing" is the
 * human phrasing, so the tool's own description has to be what routes the model there. If this
 * test starts failing at the claim step, the tool description regressed.
 */
const PROMPT = [
  'Analyze this vault with two subagents working in parallel: one on the finances hub and one on',
  'the career hub. Before you launch each subagent, claim its job with synapse and get that agent',
  'its briefing, so the two do not collide, and pass each subagent its briefing as its',
  'instructions. When both have finished, release each claim, then tell me what you now know',
  'about me in each of those two areas.',
].join(' ');

/** note-…, plan-…, decision-… — the id shape the vault cites itself by. */
const CITATION = /\b(note|plan|decision|doc)-[a-z0-9]+(-[a-z0-9]+)+/;

test('one ask, two briefed subagents, two leases returned', async ({ openVaults }) => {
  // Two subagents reading a hub each is minutes of real model work, not seconds.
  test.setTimeout(15 * 60 * 1000);

  const { 'synapse-vault': session } = await openVaults(['synapse-vault']);
  await session.ask(PROMPT);

  // --- it delegated, rather than doing the reading itself ---------------------
  const claims = session.callsFor('synapse_claim_and_brief');
  expect(claims.length, 'one claim per doer').toBe(2);
  for (const call of claims) expect(call.state).toBe('ok');

  // --- the doers actually ran, in DSH's own subagent machinery ----------------
  // `subagent` is a DSH-native tool, so no mcp__synapse__ prefix — see nativeCallsFor().
  const subagents = session.nativeCallsFor('subagent');
  expect(subagents.length, 'two subagents should have been launched').toBeGreaterThanOrEqual(2);

  // --- and every lease came back ----------------------------------------------
  const releases = session.callsFor('synapse_spawn_release');
  expect(releases.length, 'both claims must be released').toBe(2);
  for (const call of [...claims, ...releases]) expect(call.state).toBe('ok');

  // --- the briefings carried real vault content into the doers -----------------
  // The only load-bearing assertion in this file. Two claims and two subagents prove the
  // plumbing; they do not prove the briefing had anything IN it. A subagent that received an
  // empty briefing would still answer — from the model's own priors, with no ids to cite.
  // Vault note ids are the one thing it cannot produce that way, and none of them appear in
  // the prompt, so a citation is content that travelled vault → briefing → subagent → answer.
  expect(session.text, 'the answer should cite vault notes, not general knowledge')
    .toMatch(CITATION);
  expect(session.text.toLowerCase(), 'both hubs should appear in the answer').toMatch(/career/);
  expect(session.text.toLowerCase(), 'both hubs should appear in the answer').toMatch(/financ/);
});
