// standalone.test.mjs — the pull-only stack as a CONTRACT.
//
// This file's whole promise is "two files and `docker compose up`, no checkout". Every claim in that
// sentence is one careless edit from being false, and each failure is silent: a `build:` key that
// creeps back in makes the file unusable without a source tree, while still working perfectly on the
// machine that has one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseStrict } from "./compose-yaml.mjs";

const DEPLOY = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(DEPLOY, rel), "utf8");

const TEXT = read("standalone/compose.yml");
const compose = parseStrict(TEXT, "standalone.test");
const ENV = read("standalone/.env.example");
const svc = (name) => {
  const found = compose.services[name];
  assert.ok(found, `standalone/compose.yml must define ${name}`);
  return found;
};

test("NO service builds — a source checkout is not a prerequisite", () => {
  for (const [name, service] of Object.entries(compose.services)) {
    assert.equal(service.build, undefined, `${name} must not build; that is what ../compose.yml is for`);
    assert.ok(service.image, `${name} must name an image to pull`);
  }
});

test("core and dsh default to published images, overridable by tag", () => {
  assert.match(svc("synapse-core").image, /^\$\{CORE_IMAGE:-ghcr\.io\/eborjaa\/synapse-core:/);
  assert.match(svc("dsh").image, /^\$\{DSH_IMAGE:-ghcr\.io\/eborjaa\/synapse-dsh:/);
});

test("forgetting BIND_ADDR is SAFE — it defaults to loopback, never a wildcard", () => {
  // Docker publishes a port before any container starts, so nothing inside the stack can catch a
  // wildcard here. The default is the guard.
  const ports = svc("dsh").ports;
  assert.equal(ports.length, 1);
  assert.match(ports[0], /^\$\{BIND_ADDR:-127\.0\.0\.1\}:/);
  for (const bad of ["0.0.0.0", '"::"', "${BIND_ADDR}:"]) {
    assert.equal(ports[0].includes(`-${bad}`), false, `default must not be ${bad}`);
  }
});

test("only dsh publishes to the host; core is reachable only inside the namespace", () => {
  assert.equal(svc("synapse-core").ports, undefined, "core must never publish a host port");
  assert.equal(svc("synapse-core").network_mode, "service:dsh");
  assert.equal(svc("vpn-sidecar").network_mode, "service:dsh", "swapping the VPN must not move the UI");
  assert.equal(svc("synapse-core").environment.SYNAPSE_MCP_HOST, "127.0.0.1");
  assert.equal(
    JSON.stringify(svc("synapse-core").environment).includes("BIND_ADDR"),
    false,
    "BIND_ADDR is a host-publish concern; passing it to core would make core listen on it",
  );
});

test("exactly one core survives the move to published images", () => {
  assert.equal(svc("synapse-core").container_name, "synapse-core");
  assert.equal(svc("synapse-core").deploy.replicas, 1);
});

test("the credential store is NEVER mounted into the web container", () => {
  const dshVolumes = JSON.stringify(svc("dsh").volumes);
  assert.equal(dshVolumes.includes("config"), false, "tokens.json must not be one directory from a web process");
  assert.ok(svc("synapse-core").volumes.some((v) => v.startsWith("config:")));
  assert.ok(svc("dsh").volumes.includes("skills:/skills:ro"), "dsh reads rosters, read-only");
});

test("vaults are a BIND MOUNT from the host, so nobody has to docker cp them in", () => {
  for (const name of ["dsh", "synapse-core"]) {
    const mount = svc(name).volumes.find((v) => v.endsWith(":/synapse/vaults"));
    assert.ok(mount, `${name} must mount the host vaults directory`);
    assert.match(mount, /^\$\{SYNAPSE_VAULTS_DIR:-/, `${name} must take that path from the environment`);
  }
});

test("ONE variable feeds both containers, so no secret is carried between them by hand", () => {
  // The whole point: core registers this value as a credential, dsh presents it. Two variables would
  // mean two places to get it wrong, and the failure (tools silently absent) names neither.
  assert.equal(svc("synapse-core").environment.SYNAPSE_BOOTSTRAP_TOKEN, "${SYNAPSE_BOOTSTRAP_TOKEN:-}");
  assert.equal(svc("dsh").environment.SYNAPSE_MCP_TOKEN, "${SYNAPSE_BOOTSTRAP_TOKEN:-}");
});

test("the DSH plugin gets a BASE url, not a vault-pinned endpoint", () => {
  // A pinned /mcp/<id> makes every session answer from one vault AND look correct.
  assert.equal(
    svc("dsh").environment.SYNAPSE_MCP_HTTP_URL,
    "${SYNAPSE_MCP_HTTP_URL:-http://127.0.0.1:3000/mcp}",
  );
});

test("core is told where the vaults are, or auto-register has nothing to scan", () => {
  assert.equal(svc("synapse-core").environment.SYNAPSE_VAULTS_DIR, "/synapse/vaults");
  assert.equal(svc("synapse-core").environment.SYNAPSE_AUTO_REGISTER, "${SYNAPSE_AUTO_REGISTER:-}");
});

test("both bootstrap switches default to EMPTY — an existing stack is unchanged", () => {
  for (const key of ["SYNAPSE_AUTO_REGISTER", "SYNAPSE_BOOTSTRAP_TOKEN"]) {
    assert.match(
      String(svc("synapse-core").environment[key]),
      /:-\}$/,
      `${key} must default to empty, or upgrading a stack would register vaults its owner did not`,
    );
  }
});

test("every durable path is a named volume, except the vaults you deliberately bind", () => {
  const declared = Object.keys(compose.volumes).sort();
  assert.deepEqual(declared, ["config", "dsh-home", "ollama", "skills", "vpn-state"]);
  for (const [name, service] of Object.entries(compose.services)) {
    for (const mount of service.volumes || []) {
      const source = String(mount).split(":")[0];
      if (source.startsWith("${SYNAPSE_VAULTS_DIR")) continue;   // the one intentional bind mount
      assert.ok(declared.includes(source), `${name} mounts "${source}", which is not a declared volume`);
    }
  }
});

test("ollama stays behind a profile — the deterministic core works without it", () => {
  assert.deepEqual(svc("ollama").profiles, ["embeddings"]);
});

test(".env.example documents all three bootstrap modes, and ships no secret", () => {
  assert.match(ENV, /MODE 1/);
  assert.match(ENV, /MODE 2/);
  assert.match(ENV, /MODE 3/);
  assert.match(ENV, /^SYNAPSE_BOOTSTRAP_TOKEN=$/m, "the example must ship EMPTY, never with a value in it");
  assert.match(ENV, /openssl rand/, "it must say how to generate one");
  assert.match(ENV, /SYNAPSE_VAULTS_DIR=/);
});

test(".env.example never suggests a wildcard bind", () => {
  assert.equal(/^BIND_ADDR=(0\.0\.0\.0|::)\s*$/m.test(ENV), false);
  assert.match(ENV, /^BIND_ADDR=127\.0\.0\.1$/m);
});

test("every variable the compose file reads is mentioned in .env.example", () => {
  // A variable that only exists in YAML is a setting nobody can discover.
  const used = new Set([...TEXT.matchAll(/\$\{([A-Z0-9_]+)[:}-]/g)].map((m) => m[1]));
  const missing = [...used].filter((name) => !ENV.includes(name)).sort();
  assert.deepEqual(missing, [], `undocumented in .env.example: ${missing.join(", ")}`);
});
