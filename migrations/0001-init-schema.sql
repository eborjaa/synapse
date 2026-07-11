-- 0001-init-schema.sql — Synapse records substrate (SQLite).
-- Migrations are the DB's source of truth and its audit log; this one creates the whole schema.
-- Conventions: money = integer cents; dates/datetimes = ISO-8601 TEXT; `slug` ties a row to its
-- generated Markdown view (contacts/<slug>.md, accounts/<slug>.md). Forward-only; revert = a new
-- compensating migration (see migrations/README.md). Applied by _meta/tools/apply-migrations.mjs.

PRAGMA foreign_keys = ON;

-- ============================ VAULT META (identity / ownership) ============================
-- Small key/value table for vault identity (owner, handle, created date). Seed it yourself via a
-- copy of migrations/0002-owner.sql.example → 0002-owner.sql (no seed data ships here).
CREATE TABLE vault_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================ CONTACTS & PEOPLE ============================
CREATE TABLE contacts (
  id          INTEGER PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,                 -- = contacts/<slug>.md basename
  full_name   TEXT NOT NULL,
  given_name  TEXT,
  family_name TEXT,
  org         TEXT,
  title       TEXT,
  birthday    TEXT,                                  -- ISO date (YYYY-MM-DD)
  person_note TEXT,                                  -- optional [[person-…]] basename (link, never duplicate)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE contact_emails (
  id         INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  label      TEXT,                                   -- home | work | …
  email      TEXT NOT NULL
);
CREATE TABLE contact_phones (
  id         INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  label      TEXT,
  phone      TEXT NOT NULL
);
CREATE TABLE addresses (
  id          INTEGER PRIMARY KEY,
  contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,  -- nullable: an address may stand alone
  label       TEXT,                                  -- home | work | …
  line1       TEXT, line2 TEXT, city TEXT, region TEXT, postal_code TEXT, country TEXT,
  lat         REAL, lng REAL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contact_emails_contact ON contact_emails(contact_id);
CREATE INDEX idx_contact_phones_contact ON contact_phones(contact_id);
CREATE INDEX idx_addresses_contact      ON addresses(contact_id);
CREATE INDEX idx_addresses_city         ON addresses(city);

-- ============================ FINANCES ============================
CREATE TABLE accounts (
  id          INTEGER PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,                  -- = accounts/<slug>.md basename
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,                         -- checking|savings|credit|investment|cash|loan
  institution TEXT,
  currency    TEXT NOT NULL DEFAULT 'USD',
  opened_on   TEXT, closed_on TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE account_balances (                       -- time-series → charts balance over time
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  as_of         TEXT NOT NULL,                        -- ISO date
  balance_cents INTEGER NOT NULL,                     -- signed minor units
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE categories (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  kind      TEXT NOT NULL DEFAULT 'expense'           -- income|expense|transfer
);
CREATE TABLE transactions (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  occurred_on  TEXT NOT NULL,                         -- ISO date
  amount_cents INTEGER NOT NULL,                      -- signed minor units (− outflow, + inflow)
  currency     TEXT NOT NULL DEFAULT 'USD',
  payee        TEXT,
  category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  contact_id   INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  memo         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_balances_account ON account_balances(account_id, as_of);
CREATE INDEX idx_txn_account_date ON transactions(account_id, occurred_on);
CREATE INDEX idx_txn_category     ON transactions(category_id);

-- ============================ HEALTH / FITNESS ============================
CREATE TABLE health_metrics (                         -- tall/flexible: a new metric needs no schema change
  id          INTEGER PRIMARY KEY,
  measured_at TEXT NOT NULL,                           -- ISO datetime
  metric      TEXT NOT NULL,                           -- weight_kg|resting_hr|hrv|sleep_hours|steps|body_fat_pct|…
  value       REAL NOT NULL,
  unit        TEXT,
  source      TEXT                                     -- manual|apple_health|…
);
CREATE TABLE workouts (
  id           INTEGER PRIMARY KEY,
  occurred_on  TEXT NOT NULL,
  type         TEXT NOT NULL,                          -- run|lift|ride|swim|…
  duration_min REAL, distance_km REAL, calories INTEGER, avg_hr INTEGER,
  notes        TEXT, source TEXT
);
CREATE INDEX idx_health_metric_date ON health_metrics(metric, measured_at);
CREATE INDEX idx_workouts_date      ON workouts(occurred_on);

-- ============================ GEOLOCATION (places + manual visits) ============================
CREATE TABLE places (                                 -- gazetteer of meaningful named places
  id         INTEGER PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  category   TEXT,                                     -- home|work|gym|restaurant|…
  lat        REAL, lng REAL,
  address_id INTEGER REFERENCES addresses(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE visits (                                  -- manual/imported visit log (time-series)
  id          INTEGER PRIMARY KEY,
  place_id    INTEGER REFERENCES places(id) ON DELETE SET NULL,
  arrived_at  TEXT NOT NULL,
  departed_at TEXT,
  lat         REAL, lng REAL,
  source      TEXT
);
CREATE INDEX idx_visits_place ON visits(place_id, arrived_at);

-- ============================ GENERATED PROJECTIONS (Markdown → SQL) ============================
-- These are regenerated from the vault by _meta/tools/gen-index.mjs; never hand-written.
CREATE TABLE plans (                                   -- from plan-*.md frontmatter
  slug         TEXT PRIMARY KEY,                       -- = plan note basename
  title        TEXT NOT NULL,
  status       TEXT,                                   -- todo|doing|done|blocked|dropped
  priority     TEXT,                                   -- low|med|high
  due_on       TEXT,                                   -- ISO date
  project_slug TEXT,                                   -- → hub-<project> / project-<slug>
  updated_at   TEXT
);
CREATE TABLE notes (                                   -- the .md index: one row per vault note
  id        TEXT PRIMARY KEY,                          -- basename
  type      TEXT NOT NULL,
  title     TEXT,
  path      TEXT NOT NULL,
  status    TEXT,
  tags      TEXT,                                       -- JSON array
  tokens    INTEGER,
  generated INTEGER NOT NULL DEFAULT 0,
  mtime     TEXT
);
CREATE TABLE note_links (                              -- one row per frontmatter edge
  src   TEXT NOT NULL,
  dst   TEXT NOT NULL,
  field TEXT NOT NULL,
  role  TEXT NOT NULL                                   -- CONSTRAINS|USES|DELEGATES|BINDS|ATTACHES|NAVIGATES|REFERENCES
);
CREATE INDEX idx_note_links_src ON note_links(src);
CREATE INDEX idx_note_links_dst ON note_links(dst);
CREATE INDEX idx_notes_type     ON notes(type);
