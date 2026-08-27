import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DSH = process.env.DSH_CONTAINER ?? 'synapse-dsh';

/**
 * Properties of the running stack that no amount of UI clicking can show, and that the UI
 * tests would silently keep passing without:
 *
 *  - the plugin talks HTTP to synapse-core; it must NOT be quietly falling back to spawning
 *    a stdio `synapse-mcp` child, which would bind by cwd and make the UI tests pass for the
 *    wrong reason;
 *  - each open folder gets its OWN path-addressed endpoint;
 *  - a plugin credential never reaches the admin surface.
 *
 * These shell out to `docker exec`. That coupling is deliberate — the claims are about the
 * deployed stack, and asserting them anywhere else would be asserting them about a fiction.
 */
const sh = async (script) => (await run('docker', ['exec', DSH, 'sh', '-lc', script])).stdout.trim();

test.describe('stack guards', () => {
  test('the DSH container runs no stdio synapse-mcp child', async () => {
    const count = await sh('ps aux | grep "[s]ynapse-mcp" | wc -l');
    expect(Number(count), 'the plugin must reach core over HTTP, not spawn a local writer').toBe(0);
  });

  test('each open folder is served at its own path-addressed endpoint', async () => {
    const log = (await run('docker', ['logs', DSH])).stderr + (await run('docker', ['logs', DSH])).stdout;
    for (const vaultId of ['synapse-vault', 'arch-vault', 'univa', 'synapse-framework']) {
      expect(log, `${vaultId} should have its own core endpoint`)
        .toContain(`http://127.0.0.1:3000/mcp/${vaultId}`);
    }
  });

  test('the plugin credential sees the orchestrator surface and no admin tools', async () => {
    // The token is read inside the container and never crosses back out.
    const out = await sh(`
      for v in synapse-vault arch-vault univa synapse-framework; do
        r=$(curl -s -X POST "http://127.0.0.1:3000/mcp/$v" \
          -H "Authorization: Bearer $SYNAPSE_MCP_TOKEN" \
          -H "Content-Type: application/json" \
          -H "Accept: application/json, text/event-stream" \
          -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
        total=$(printf "%s" "$r" | grep -o '"name":"synapse_[a-z_]*"' | sort -u | wc -l)
        admin=$(printf "%s" "$r" | grep -o '"name":"synapse_admin_[a-z_]*"' | sort -u | wc -l)
        printf "%s %s %s\n" "$v" "$total" "$admin"
      done
    `);

    const rows = out.split('\n').map((line) => line.trim().split(/\s+/));
    expect(rows).toHaveLength(4);
    for (const [vaultId, total, admin] of rows) {
      expect(Number(total), `${vaultId} should serve the orchestrator surface`).toBe(27);
      expect(Number(admin), `${vaultId} must expose no admin tools`).toBe(0);
    }
  });
});
