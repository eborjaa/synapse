import { expect } from '@playwright/test';

/**
 * Page object for one DeepSeek Harness chat session bound to one open folder (vault).
 *
 * Every locator below is anchored on a semantic attribute the UI already emits
 * (`data-slot`, `data-chat-anchor-key`, `data-tool`, `data-state`) or on an ARIA role.
 * No CSS-module class names — those are content-hashed and change on every DSH build.
 */
export class DshSession {
  /** @param {import('@playwright/test').Page} page @param {string} vaultId @param {string} [authPath] */
  constructor(page, vaultId, authPath = '/') {
    this.page = page;
    this.vaultId = vaultId;
    this.authPath = authPath;
    /** Everything seen so far, kept because the DOM will not keep it. See capture(). */
    this.calls = [];
    this.text = '';
  }

  // ---- structural locators -------------------------------------------------

  /** The composer. Its accessible name changes after the first turn, so match both. */
  get composer() {
    return this.page.getByRole('textbox', { name: /Describe what you want|Message the agent|Message or run a task/ });
  }

  get workspaceChip() {
    return this.page.getByRole('button', { name: 'Choose workspace' });
  }

  /** Disabled exactly when the composer is empty — which makes it a send RECEIPT, see ask(). */
  get sendButton() {
    return this.page.getByRole('button', { name: 'Send message' });
  }

  /** One node per COMPLETED turn — `data-turn-tail` is the 0.1.2 semantic attribute. */
  get turnTails() {
    return this.page.locator('[data-turn-tail]');
  }

  // ---- actions -------------------------------------------------------------

  /** Open a fresh session and bind it to `vaultId`, failing if the binding did not take. */
  async open() {
    await this.page.goto(this.authPath);
    await this.page.getByRole('button', { name: 'New session' }).filter({ hasText: 'New Session' }).click();
    await this.workspaceChip.click();
    await this.page.getByRole('menuitem', { name: this.vaultId, exact: true }).click();

    // The whole suite is meaningless if the session is bound to the wrong folder, so this is
    // an assertion and not a wait: it is the precondition every later claim rests on.
    await expect(this.workspaceChip, `session should be bound to ${this.vaultId}`)
      .toHaveText(new RegExp(`\\b${escapeRegExp(this.vaultId)}\\b`));
  }

  /** Register a folder as a DSH workspace. Idempotent: an already-known folder is reused. */
  async addWorkspace(absolutePath, vaultId) {
    await this.page.goto(this.authPath);
    await this.workspaceChip.click();

    const existing = this.page.getByRole('menuitem', { name: vaultId, exact: true });
    if (await existing.count()) {
      await this.page.keyboard.press('Escape');
      return;
    }

    await this.page.getByRole('menuitem', { name: /Add workspace/ }).click();
    const dialog = this.page.getByRole('dialog', { name: 'Select Workspace Directory' });
    await dialog.getByRole('button', { name: 'Edit path' }).click();
    const path = dialog.getByRole('textbox', { name: 'Edit path' });
    await path.fill(absolutePath);
    await path.press('Enter');
    // The picker must actually be standing in that folder before "Open" means anything.
    await expect(dialog.getByRole('button', { name: vaultId, exact: true }).first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(dialog).toBeHidden();
  }

  /**
   * Send one prompt and wait for the turn to SETTLE.
   *
   * Submitted with the Send button, NOT with Enter. Enter in this composer is a newline as
   * often as it is a send; when it was a newline the prompt just sat in the box and the test
   * spent its whole budget waiting for a turn nobody had started. The button has one meaning.
   *
   * The three steps are each an assertion for a reason:
   *   enabled   — the composer really took the text (fill on a not-yet-hydrated box is a no-op)
   *   disabled  — the send was ACCEPTED and the box cleared, so we are not waiting on nothing
   *   turnTails — the turn SETTLED. Everything after this reads a finished reply, which is what
   *               makes an absence assertion mean "not there" instead of "not there yet".
   */
  async ask(prompt) {
    const settled = await this.turnTails.count();
    await this.composer.click();
    await this.composer.fill(prompt);
    await expect(this.sendButton, 'composer should have accepted the prompt').toBeEnabled();
    // Four parallel sessions share server-side chrome. The Send button often
    // detaches mid-click; force + one refill covers that remount.
    try {
      await this.sendButton.click({ force: true, timeout: 8_000 });
    } catch {
      const shown = await this.composer.innerText().catch(() => '');
      if (!shown.includes(prompt.slice(0, 24))) {
        await this.composer.click();
        await this.composer.fill(prompt);
        await expect(this.sendButton).toBeEnabled();
      }
      if (await this.sendButton.isEnabled()) {
        await this.sendButton.click({ force: true });
      }
    }
    await expect.poll(async () =>
      (await this.sendButton.isDisabled()) || (await this.turnTails.count()) > settled,
      { timeout: 30_000, message: 'the prompt should have been sent, not left in the box' },
    ).toBe(true);
    // Poll-capture while the turn runs. A long turn virtualizes earlier rows out of
    // the DOM before the turn-tail appears; waiting only at settle would lose them.
    // Turn-tail can also appear WHILE a tool row is still `running` (0.1.2), so we
    // wait until no in-flight rows remain and promote captured state as it changes.
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await this.capture();
      const tails = await this.turnTails.count();
      const running = await this.page.locator('[data-tool][data-state="running"]').count();
      if (tails >= settled + 1 && running === 0) break;
      await this.page.waitForTimeout(1000);
    }
    await expect(this.turnTails).toHaveCount(settled + 1);
    await expect(this.page.locator('[data-tool][data-state="running"]'),
      'in-flight tool rows should finish before we assert on them').toHaveCount(0);
    return this.capture();
  }

  /**
   * Read the transcript RIGHT NOW, while it is still in the DOM, and remember it.
   *
   * THE REASON THIS EXISTS. DSH virtualizes the message flow: once a reply is long enough to
   * fill the viewport, the tool rows above it are UNMOUNTED, not merely scrolled away. One
   * session measured here went from 21 `[data-tool]` rows to 1 without anything happening in
   * between. A live locator asserted after the fact therefore reports "this tool was never
   * called" when it was — the single most misleading failure this suite can produce, because it
   * accuses the product of a bug that belongs to the test.
   *
   * So every turn is snapshotted at the moment it settles and the assertions run against the
   * accumulated snapshot. Web-first assertions assume the DOM keeps what it rendered; this one
   * does not, and capturing is what is left.
   */
  async capture() {
    const snap = await this.page.evaluate(() => ({
      text: document.querySelector('[data-slot="conversation.view"]')?.innerText ?? '',
      calls: [...document.querySelectorAll('[data-tool]')].map((n) => ({
        id: n.closest('[data-chat-call-id]')?.getAttribute('data-chat-call-id') ?? null,
        tool: n.getAttribute('data-tool'),
        state: n.getAttribute('data-state'),
        label: n.innerText.replace(/\s+/g, ' ').slice(0, 300),
      })),
    }));

    this.text += `\n${snap.text}`;
    for (const call of snap.calls) {
      const idx = this.calls.findIndex((c) =>
        (call.id && c.id === call.id) || (!call.id && c.tool === call.tool && c.label === call.label));
      if (idx >= 0) {
        // First snapshot often catches `running`; a later one has `ok`/`error`.
        if (call.state && call.state !== this.calls[idx].state) {
          this.calls[idx] = { ...this.calls[idx], ...call };
        }
        continue;
      }
      this.calls.push(call);
    }
    return snap;
  }

  /** Every captured call to one SYNAPSE tool, across the whole test. */
  callsFor(tool) {
    return this.calls.filter((c) => c.tool === `mcp__synapse__${tool}`);
  }

  /** Every captured call to one of DSH's OWN tools (`subagent`, `send_message`, …). */
  nativeCallsFor(tool) {
    return this.calls.filter((c) => c.tool === tool);
  }

  /**
   * Ask for a tool call, then assert the tool itself reported success.
   *
   * "At least one more call" rather than "exactly one more": a model is free to call a tool
   * several times in a turn (retry a rejected argument, probe a second target) and that is not
   * the property under test. Pinning it to exactly one would fail the suite for a legal turn.
   * The count is read AFTER `ask` has waited for the turn to settle, so it is not a race.
   */
  async callTool(tool, prompt) {
    const before = this.callsFor(tool).length;
    const snap = await this.ask(prompt);
    const made = this.callsFor(tool);
    expect(made.length, `${tool} should have been called`).toBeGreaterThan(before);
    expect(made.at(-1).state, `${tool} should have succeeded`).toBe('ok');
    return snap;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
