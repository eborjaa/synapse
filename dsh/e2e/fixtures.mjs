import { test as base } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DshSession } from './dsh-session.mjs';

/**
 * One id per `npx playwright test` invocation. Every marker and job id this suite writes
 * carries it, so a second run never collides with the episodes the first run left behind —
 * which matters because episodic memory is append-only and searched by keyword.
 */
export const RUN_ID = process.env.PW_RUN_ID ?? randomUUID().slice(0, 8);

/**
 * DSH 0.1.2 prints a process token and 401s `/` until a browser exchanges it
 * for a cookie. `DSH_TOKEN` wins; otherwise scrape the latest `dsh web:` line.
 */
export function dshAuthPath() {
  const token = process.env.DSH_TOKEN ?? scrapeDshToken();
  return `/?token=${token}`;
}

function scrapeDshToken() {
  const name = process.env.DSH_CONTAINER ?? 'synapse-dsh';
  const r = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const matches = [...text.matchAll(/[?&]token=([A-Za-z0-9_-]{43})/g)];
  const token = matches.at(-1)?.[1];
  if (!token) {
    throw new Error(`no dsh process token in docker logs of ${name}; set DSH_TOKEN`);
  }
  return token;
}

/**
 * What makes each vault recognisable. These are the identifiers a correctly-bound session
 * MUST see, and — just as important — the identifiers it must NOT see from anywhere else.
 *
 * `absent` deliberately lists tokens owned by the OTHER three vaults. A binding bug that
 * pointed two folders at one vault would satisfy `present` and fail here.
 */
export const VAULTS = {
  'synapse-vault': {
    path: '/synapse/vaults/synapse-vault',
    present: ['agent-oracle', 'finance-specialist', 'hub-finances', 'hub-mycology', 'hub-synapse-saas'],
    absent: ['architect', 'hub-epic-', 'hub-aulasync', 'hub-iot', 'hub-reservations'],
  },
  'arch-vault': {
    path: '/synapse/vaults/arch-vault',
    present: ['architect', 'planner', 'reviewer', 'hub-epic-', 'hub-project'],
    absent: ['agent-oracle', 'finance-specialist', 'hub-finances', 'hub-mycology', 'hub-aulasync'],
  },
  univa: {
    path: '/synapse/vaults/univa',
    present: ['agent-curator', 'agent-oracle', 'hub-aulasync', 'hub-iot', 'hub-reservations'],
    absent: ['architect', 'finance-specialist', 'hub-epic-', 'hub-mycology', 'hub-synapse-saas'],
  },
  'synapse-framework': {
    path: '/synapse/vaults/synapse-framework',
    present: ['agent-curator', 'agent-ingester', 'agent-oracle', 'agent-reconciler', 'hub-finances'],
    // synapse-framework is the trap: it shares agents AND hub-finances with synapse-vault.
    // Only the hubs synapse-vault adds on top separate them, so those are the real fingerprint.
    absent: ['finance-specialist', 'architect', 'hub-mycology', 'hub-synapse-saas', 'hub-iot', 'hub-epic-'],
  },
};

export const VAULT_IDS = Object.keys(VAULTS);

/** A task string unique to this run and this vault. */
export const markerFor = (vaultId) => `E2E-${vaultId.toUpperCase()}-MARK-${RUN_ID}`;

/**
 * A summary unique to this run and this vault, and — critically — one that never appears in
 * any prompt sent to another vault's session. See episodic-memory.spec.mjs for why.
 */
export const summaryFor = (vaultId) => `episodic fingerprint ${vaultId} ${RUN_ID}`;

export const test = base.extend({
  /**
   * Opens one DSH session per requested vault, each in its own browser context so nothing a
   * browser holds (cookies, local storage, the active workspace) is shared between them.
   *
   *   const sessions = await openVaults(['synapse-vault', 'arch-vault']);
   *
   * Creation is SEQUENTIAL and that is not an oversight. A DSH session is server-side state
   * shared by every context, so two contexts opening a session at once race for the same
   * "New Session" draft and one of them ends up bound to the other's. Sending, which is the
   * part that has to overlap for a parallel-isolation claim to mean anything, is done by the
   * tests with Promise.all once all the sessions exist.
   */
  openVaults: async ({ browser }, use) => {
    const contexts = [];

    const openVaults = async (vaultIds) => {
      const sessions = [];
      for (const vaultId of vaultIds) {
        const context = await browser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        const session = new DshSession(page, vaultId, dshAuthPath());
        await session.addWorkspace(VAULTS[vaultId].path, vaultId);
        await session.open();
        sessions.push(session);
      }
      return Object.fromEntries(sessions.map((s) => [s.vaultId, s]));
    };

    await use(openVaults);
    await Promise.all(contexts.map((c) => c.close()));
  },
});

export { expect } from '@playwright/test';
