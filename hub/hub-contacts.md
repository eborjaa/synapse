---
id: hub-contacts
type: hub
title: Contacts & people — domain hub
tags:
  - type/hub
  - area/contacts
  - status/active
references_docs: ["[[doc-sql-schema]]", "[[doc-storage-model]]"]
related: ["[[hub-synapse]]", "[[decision-0002-contact-record-plus-narrative]]"]
---

# Contacts & people — domain hub

The map for **people**. A person is modelled as two linked halves: a structured **contact** record
(SQL-canonical, surfaced as a generated `contacts/<slug>.md` view) plus an optional hand-authored
**person** narrative note — they link, never duplicate
([[decision-0002-contact-record-plus-narrative]]).

## What lives here
- **Contact views** — one generated view per contact row (`contacts/<slug>.md`), regenerated from SQL.
- **Person notes** — optional prose, created only when there is real narrative; links to its contact
  rather than restating fields ([[rule-synapse-single-source-of-truth]]).

## How to work this domain
- **Add a contact:** propose a row via a `migrations/` file (human-gated PR), then `gen-views.mjs`
  regenerates its `contacts/<slug>.md` view.
- **Add narrative:** author a `person` note only when there's real prose; link it to the contact rather
  than restating fields ([[rule-synapse-single-source-of-truth]]).
- **Maintenance pass:** `reconciler hub-contacts` to reconcile one drifted view/note, or `curator
  hub-contacts` for a stewarded sweep.

## Members
*Populate as records and notes land.* Contact views and person notes roll up here once they link back via
`related` ([[rule-synapse-edges-by-role]]).

## Related
[[decision-0002-contact-record-plus-narrative]] · [[doc-sql-schema]] · [[doc-storage-model]] · [[hub-synapse]]
