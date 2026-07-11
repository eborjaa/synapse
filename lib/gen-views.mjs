#!/usr/bin/env node
// gen-views.mjs — rebuild the SQL → Markdown derived views from canonical record rows.
//
//   node _meta/tools/gen-views.mjs
//
// SQL is canonical for records; the per-row / per-period Markdown notes under contacts/, accounts/,
// finances/ are GENERATED projections so records stay linkable in Obsidian and visible in git
// ([[rule-derived-views-are-generated]]). Every generated note carries `generated: true` + a `source:`
// pointer and is NEVER hand-edited. This tool opens db/synapse.db READ-ONLY ({ readOnly: true } — verified
// to reject INSERT/CREATE on node v25) and only writes .md files; it can never mutate the DB.
//
// Conventions enforced here: money = integer cents → formatted currency; dates = ISO TEXT; BLOCK-STYLE
// tags; the view basename is prefixed (contact-/account-/summary-) so filename-prefix matches type.
// ROOT = the vault root (2 up from _meta/tools/).

import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveVault } from "./vault-root.mjs";

const { vaultDir: ROOT } = resolveVault({ readManifest: false });
const DB_PATH = join(ROOT, "db", "synapse.db");

if (!existsSync(DB_PATH)) {
  console.error(`[gen-views] db not found at ${DB_PATH} — run apply-migrations.mjs first.`);
  process.exit(1);
}

// READ-ONLY: { readOnly: true } opens the file with SQLITE_OPEN_READONLY; any write is rejected
// ("attempt to write a readonly database"). The query/view path can never mutate canonical records.
const db = new DatabaseSync(DB_PATH, { readOnly: true });

// integer cents → currency string, e.g. 123456 / "USD" → "$1,234.56".
const SYMBOL = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" };
function money(cents, currency = "USD") {
  const neg = cents < 0;
  const v = Math.abs(cents) / 100;
  const s = v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sym = SYMBOL[currency] || "";
  return `${neg ? "-" : ""}${sym}${s}${sym ? "" : " " + currency}`;
}

const DO_NOT_EDIT =
  "> Generated view — do not edit. Source of truth is the SQL record; regeneration overwrites this file.\n" +
  "> Edit the canonical row, then re-run `gen-views.mjs` (see [[rule-derived-views-are-generated]]).";

let written = 0;

// ============================ CONTACTS ============================
const contacts = db.prepare(`SELECT * FROM contacts ORDER BY slug`).all();
const emailsBy = db.prepare(`SELECT * FROM contact_emails WHERE contact_id = ? ORDER BY id`);
const phonesBy = db.prepare(`SELECT * FROM contact_phones WHERE contact_id = ? ORDER BY id`);
const addrsBy = db.prepare(`SELECT * FROM addresses WHERE contact_id = ? ORDER BY id`);

for (const c of contacts) {
  const id = `contact-${c.slug}`;
  const related = ['"[[hub-contacts]]"'];
  if (c.person_note) related.push(`"[[${c.person_note}]]"`);

  const fm = [
    "---",
    `id: ${id}`,
    "type: contact",
    `title: ${JSON.stringify(c.full_name)}`,
    "tags:",
    "  - type/contact",
    "  - area/contacts",
    "  - status/active",
    "generated: true",
    `source: "db:contacts slug=${c.slug}"`,
    `related: [${related.join(", ")}]`,
    "---",
  ].join("\n");

  const lines = [`# ${c.full_name}`, "", DO_NOT_EDIT, ""];
  if (c.org || c.title) lines.push(`- **Org / title:** ${[c.title, c.org].filter(Boolean).join(" @ ")}`);

  const emails = emailsBy.all(c.id);
  for (const e of emails) lines.push(`- **Email${e.label ? ` (${e.label})` : ""}:** ${e.email}`);
  const phones = phonesBy.all(c.id);
  for (const p of phones) lines.push(`- **Phone${p.label ? ` (${p.label})` : ""}:** ${p.phone}`);
  if (c.birthday) lines.push(`- **Birthday:** ${c.birthday}`);
  const addrs = addrsBy.all(c.id);
  for (const a of addrs) {
    const parts = [a.line1, a.line2, a.city, a.region, a.postal_code, a.country].filter(Boolean).join(", ");
    lines.push(`- **Address${a.label ? ` (${a.label})` : ""}:** ${parts}`);
  }
  if (c.person_note) lines.push("", `Narrative: [[${c.person_note}]]`);

  writeFileSync(join(ROOT, "contacts", `${id}.md`), fm + "\n\n" + lines.join("\n").trim() + "\n");
  written++;
}

// ============================ ACCOUNTS ============================
const accounts = db.prepare(`SELECT * FROM accounts ORDER BY slug`).all();
const latestBalance = db.prepare(
  `SELECT balance_cents, as_of FROM account_balances WHERE account_id = ?
   ORDER BY as_of DESC, id DESC LIMIT 1`
);

for (const a of accounts) {
  const id = `account-${a.slug}`;
  const fm = [
    "---",
    `id: ${id}`,
    "type: account",
    `title: ${JSON.stringify(a.name)}`,
    "tags:",
    "  - type/account",
    "  - area/finances",
    "  - status/active",
    "generated: true",
    `source: "db:accounts slug=${a.slug}"`,
    `related: ["[[hub-finances]]"]`,
    "---",
  ].join("\n");

  const lines = [`# ${a.name}`, "", DO_NOT_EDIT, ""];
  lines.push(`- **Type:** ${a.type}`);
  if (a.institution) lines.push(`- **Institution:** ${a.institution}`);
  lines.push(`- **Currency:** ${a.currency}`);
  const bal = latestBalance.get(a.id);
  if (bal) lines.push(`- **Latest balance:** ${money(bal.balance_cents, a.currency)} (as of ${bal.as_of})`);
  else lines.push(`- **Latest balance:** _(no balance recorded)_`);

  writeFileSync(join(ROOT, "accounts", `${id}.md`), fm + "\n\n" + lines.join("\n").trim() + "\n");
  written++;
}

// ============================ MONTHLY FINANCE SUMMARIES ============================
// One note per distinct YYYY-MM in transactions. Income / expense / net by joining the txn's category
// kind (income|expense|transfer). Amounts are integer cents (signed); we report magnitudes by kind.
const months = db.prepare(
  `SELECT DISTINCT substr(occurred_on, 1, 7) AS ym FROM transactions ORDER BY ym`
).all();
const monthTotals = db.prepare(
  `SELECT COALESCE(c.kind, 'uncategorized') AS kind,
          SUM(t.amount_cents) AS total
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
    WHERE substr(t.occurred_on, 1, 7) = ?
    GROUP BY COALESCE(c.kind, 'uncategorized')`
);

for (const { ym } of months) {
  const id = `summary-finances-${ym}`;
  const rows = monthTotals.all(ym);
  let income = 0, expense = 0;
  for (const r of rows) {
    if (r.kind === "income") income += r.total;
    else if (r.kind === "expense") expense += r.total;
    // transfers and uncategorized excluded from income/expense rollup
  }
  const net = income + expense; // expense rows are negative cents, income positive

  const fm = [
    "---",
    `id: ${id}`,
    "type: summary",
    `title: ${JSON.stringify(`Finances — ${ym}`)}`,
    "tags:",
    "  - type/summary",
    "  - area/finances",
    "  - status/active",
    "generated: true",
    `source: "db:transactions month=${ym}"`,
    `related: ["[[hub-finances]]"]`,
    "---",
  ].join("\n");

  const lines = [
    `# Finances — ${ym}`,
    "",
    DO_NOT_EDIT,
    "",
    `- **Income:** ${money(income)}`,
    `- **Expense:** ${money(expense)}`,
    `- **Net:** ${money(net)}`,
  ];

  writeFileSync(join(ROOT, "finances", `${id}.md`), fm + "\n\n" + lines.join("\n").trim() + "\n");
  written++;
}

console.log(`[gen-views] wrote ${written} view(s): ${contacts.length} contact, ${accounts.length} account, ${months.length} finance-summary`);
