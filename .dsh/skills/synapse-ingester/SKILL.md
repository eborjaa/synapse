---
name: synapse-ingester
description: Atomize one freeform inbox item into typed one-idea-per-file notes as agent-ingester, wire each into the right hub-<domain>, carry provenance, and propose it as a human-gated PR. Use when capturing, filing, atomizing, or processing raw material, notes, dumps, or anything sitting in inbox/.
---

# Ingester — turn raw material into typed notes

One inbox item per run. Split it into single-idea notes, wire each into a hub, keep provenance, and
propose — never write the DB.

## Procedure

1. **Check it was not already ingested.** `mcp__synapse__synapse_history` with distinctive phrases
   from the item. Re-ingesting produces near-duplicate notes that are painful to unpick later.
2. **Load your role and the target domain.** `mcp__synapse__synapse_brief` with `agent: "ingester"`
   and the hub you believe this belongs to.
3. **Confirm the hub before writing.** `mcp__synapse__synapse_list_hubs`. If no existing hub genuinely
   fits, propose a **new** `hub-<domain>` rather than forcing the material into a near-miss — a wrong
   hub is harder to detect later than a missing one.
4. **Atomize.** One idea per file. If a note needs "and" in its title to be accurate, it is two notes.
   Prose becomes typed notes; structured facts become **proposed migration rows**, never direct writes.
5. **Create with provenance.** `mcp__synapse__synapse_create_note` (or `synapse_create_hub`) with
   `links` to the hub and `used_by` for any agent that should cite it. Record where the material came
   from and when. **These tools propose by default** — inspect the rendered output, then re-call with
   `write: true` only when it is right.
6. **Wire it in.** A note nothing links to is an orphan the curator will flag. Every note lands in a
   hub's closure.
7. **Clear the inbox entry** only once its content is fully represented in the new notes.
8. **Verify and record.** `mcp__synapse__synapse_lint`, then `mcp__synapse__synapse_log`.

## Boundaries

- **Never write `db/synapse.db`.** Records are proposed as migrations for a human to apply.
- **Propose, do not push.** The output of a run is a reviewable PR. Never self-merge.
- **Do not invent connections.** Semantic suggestions are leads to verify; a wikilink asserts a real
  relationship. When unsure, say so in the note rather than fabricating an edge.

## Working economy (applies to every step above)

- **Reach for vault content through the MCP tools, never the filesystem.** Fetch a note by id with
  `synapse_brief(note: "<id>")`; ids resolve without paths. The vault's layout is not what it looks
  like — decisions live under `_meta/`, records are generated views — so a guessed path fails, or worse
  returns a stale copy. Never `read`/`glob` vault content by hand.
- **Brief once per hub.** Re-briefing the same hub burns context and makes the answer worse on a local
  model. When the topic shifts, call `synapse_recall` for the delta instead.
- **Stop when the question is answered.** Extra tool calls are not extra diligence.
