// compose.test.mjs — the four-container stack as a CONTRACT, not a file someone eyeballs.
//
// WHY these assertions exist at all. Every claim Epic 4 makes is one careless YAML edit away from
// being false, and the failure is silent: a stack that comes up and serves happily while publishing
// the UI on every interface, or running two cores against one DB, looks exactly like a healthy one.
// `docker compose config` would catch a syntax error; none of these are syntax errors.
//
// WHY a hand-rolled parser. The repo ships two runtime dependencies on purpose, and a YAML library
// for one test file is not worth a third. The subset below (2-space block maps, scalar lists,
// quote-aware comment stripping) covers this file completely, and parseStrict() throws on anything it
// does not understand rather than silently returning a partial tree — a parser that quietly dropped
// `ports:` would turn the most important test here into a vacuous pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const DEPLOY = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(DEPLOY);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ── the smallest YAML that reads this file ────────────────────────────────────

/** Strip a trailing `# comment`, but never one inside quotes (`"${BIND_ADDR}:8080:8080"`). */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(raw) {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  return t;
}

function parseStrict(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    const line = stripComment(raw).replace(/\s+$/, "");
    if (!line.trim()) continue;
    lines.push({ indent: line.match(/^ */)[0].length, body: line.trim() });
  }

  let i = 0;
  function block(indent) {
    if (lines[i].body.startsWith("- ")) {
      const arr = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].body.startsWith("- ")) {
        arr.push(scalar(lines[i++].body.slice(2)));
      }
      return arr;
    }
    const map = {};
    while (i < lines.length && lines[i].indent === indent) {
      const { body } = lines[i];
      const colon = body.indexOf(":");
      if (colon === -1) throw new Error(`compose.test: cannot parse line "${body}"`);
      const key = body.slice(0, colon).trim();
      const rest = body.slice(colon + 1).trim();
      i++;
      if (rest !== "") map[key] = scalar(rest);
      else if (i < lines.length && lines[i].indent > indent) map[key] = block(lines[i].indent);
      else map[key] = null;
    }
    return map;
  }

  const out = block(0);
  if (i !== lines.length) throw new Error(`compose.test: stopped at "${lines[i].body}"`);
  return out;
}

const COMPOSE_TEXT = read("deploy/compose.yml");
const compose = parseStrict(COMPOSE_TEXT);
const svc = (name) => {
  const found = compose.services[name];
  assert.ok(found, `compose.yml must define the ${name} service`);
  return found;
};

// Wildcards the MCP listener already refuses. The host-publish path must refuse the same set, or the
// two halves of "never on a public interface" drift apart.
const WILDCARDS = ["0.0.0.0", "::", "[::]", "::0", "0"];

test("the parser actually read the file — nothing below is a vacuous pass", () => {
  assert.equal(compose.name, "synapse");
  assert.deepEqual(
    Object.keys(compose.services).sort(),
    ["dsh", "ollama", "synapse-core", "vpn-sidecar"],
    "four containers, exactly the four the plan names",
  );
  assert.deepEqual(svc("dsh").ports, ["${BIND_ADDR}:8080:8080"], "the parser sees quoted list items");
  assert.equal(svc("synapse-core").deploy.replicas, 1, "the parser descends two levels");
});

test("US-4.3: nothing in the stack can publish on a public interface", () => {
  for (const wildcard of WILDCARDS) {
    assert.equal(
      COMPOSE_TEXT.includes(`"${wildcard}:`) || COMPOSE_TEXT.includes(` ${wildcard}:8080`),
      false,
      `compose.yml must never hard-code the wildcard ${wildcard} as a publish address`,
    );
  }

  // Only dsh publishes. vpn-sidecar and synapse-core share its namespace, so a `ports:` key on either
  // is not merely redundant — compose rejects it, and the person who added it meant to expose something.
  const publishers = Object.entries(compose.services)
    .filter(([, service]) => service.ports)
    .map(([name]) => name);
  assert.deepEqual(publishers, ["dsh"], "exactly one service may publish to the host");

  for (const mapping of svc("dsh").ports) {
    assert.match(mapping, /^\$\{BIND_ADDR\}:/, "the host side must come from BIND_ADDR, never a literal");
  }
});

test("US-4.3 + US-4.1: BIND_ADDR is the ONLY laptop-vs-server switch, and it is asserted before compose runs", () => {
  // Strip `#` comments first: up.sh's header explains itself by quoting `docker compose up`, and an
  // ordering check that matched prose would pass no matter where the real guard sat.
  const up = read("deploy/up.sh")
    .split("\n")
    .map((line) => (line.trimStart().startsWith("#") ? "" : line))
    .join("\n");
  const assertAt = up.indexOf("assert-bind.mjs");
  const composeAt = up.indexOf("docker compose");
  assert.ok(assertAt > -1, "up.sh must run the bind guard");
  assert.ok(composeAt > -1, "up.sh must actually invoke compose");
  assert.ok(
    assertAt < composeAt,
    "the bind must be refused BEFORE compose starts — docker publishes the port before node ever runs",
  );

  const example = read("deploy/.env.example");
  const bind = example.match(/^BIND_ADDR=(.*)$/m)?.[1]?.trim();
  assert.equal(bind, "127.0.0.1", "the shipped default must be loopback");
  assert.equal(WILDCARDS.includes(bind), false);
});

test("US-4.3: assert-bind refuses every wildcard and accepts loopback — the real script, as a process", () => {
  for (const wildcard of WILDCARDS) {
    assert.throws(
      () => execFileSync(process.execPath, [join(DEPLOY, "assert-bind.mjs"), wildcard], { stdio: "pipe" }),
      (error) => error.status === 1,
      `assert-bind must exit non-zero for ${wildcard}`,
    );
  }
  const ok = execFileSync(
    process.execPath,
    [join(DEPLOY, "assert-bind.mjs"), "127.0.0.1", "--print"],
    { encoding: "utf8" },
  );
  assert.equal(ok.trim(), "127.0.0.1");
});

test("US-4.4: the compose file cannot scale synapse-core", () => {
  const core = svc("synapse-core");
  assert.equal(core.container_name, "synapse-core", "a fixed name makes --scale=2 collide");
  assert.equal(core.deploy.replicas, 1);
  assert.equal(core.deploy.mode, "replicated");

  // A fixed container_name is what turns `--scale <svc>=2` into a name collision. Every service gets
  // one, and they must be distinct — two services sharing a name would fail to come up at all.
  const names = Object.values(compose.services).map((s) => s.container_name);
  assert.equal(names.filter(Boolean).length, names.length, "every service must carry a fixed name");
  assert.equal(new Set(names).size, names.length, "container names must be unique across the stack");
});

test("US-4.5: core owns the roster plane, dsh reads it, and the credential store is NOT beside it", () => {
  const core = svc("synapse-core");
  assert.equal(core.environment.SYNAPSE_SKILLS_ROOT, "/synapse/skills");
  assert.equal(core.environment.SYNAPSE_HOME, "/synapse/config");
  assert.notEqual(
    core.environment.SYNAPSE_SKILLS_ROOT,
    core.environment.SYNAPSE_HOME,
    "rosters are shared with dsh; tokens.json is not — they must not live on one volume",
  );
  assert.ok(core.volumes.includes("skills:/synapse/skills"), "core mounts the roster volume READ-WRITE");

  assert.deepEqual(svc("dsh").volumes, ["skills:/skills:ro"], "dsh gets the rosters, read-only, and nothing else");
  assert.equal(
    JSON.stringify(svc("dsh").volumes).includes("config"),
    false,
    "dsh must never see the config volume",
  );
});

test("US-4.2: every durable path is a NAMED volume, so destroy-and-recreate loses nothing", () => {
  const declared = Object.keys(compose.volumes).sort();
  assert.deepEqual(declared, ["config", "ollama", "skills", "vaults", "vpn-state"]);

  for (const [name, service] of Object.entries(compose.services)) {
    for (const mount of service.volumes || []) {
      const source = mount.split(":")[0];
      assert.equal(
        source.startsWith(".") || source.startsWith("/") || source.startsWith("$"),
        false,
        `${name} mounts "${mount}" from the host — a bind mount is not disposable`,
      );
      assert.ok(declared.includes(source), `${name} mounts undeclared volume "${source}"`);
    }
  }
});

test("US-4.1 + US-2: core binds loopback inside the shared namespace and never learns the host address", () => {
  const core = svc("synapse-core");
  assert.equal(core.network_mode, "service:dsh", "core shares dsh's netns so 127.0.0.1 reaches both");
  assert.equal(core.environment.SYNAPSE_MCP_HOST, "127.0.0.1");
  assert.equal(
    "BIND_ADDR" in core.environment,
    false,
    "BIND_ADDR is a host-publish concern; passing it in would make core listen on the public address",
  );
  assert.equal(svc("dsh").environment.SYNAPSE_MCP_URL, "http://127.0.0.1:3000/mcp");
  assert.equal(svc("vpn-sidecar").network_mode, "service:dsh", "swapping the VPN must not move the UI");
});

test("US-4.6: ollama is optional, and reachable from core when it is running", () => {
  const ollama = svc("ollama");
  assert.deepEqual(ollama.profiles, ["embeddings"], "the deterministic core must come up without it");
  assert.equal(svc("synapse-core").environment.SYNAPSE_OLLAMA_URL, "http://ollama:11434");
  assert.deepEqual(ollama.networks, ["synapse"], "core reaches it by DNS through dsh's netns");
  assert.deepEqual(svc("dsh").networks, ["synapse"], "dsh owns the namespace, so dsh owns the network");
});

test("every build context resolves from deploy/, because that is where compose resolves them from", () => {
  // The trap this pins: compose resolves relative paths against the PROJECT DIRECTORY, which defaults
  // to the parent of the compose file — not your shell's cwd. Written root-relative (`./deploy/dsh-stub`,
  // or `context: .` for core) every path silently gains an extra `deploy/` and nothing builds. It is
  // invisible in review, `config` still prints a valid document, and only `build` fails.
  for (const [name, service] of Object.entries(compose.services)) {
    if (!service.build) continue;
    const context = resolve(DEPLOY, service.build.context);
    const dockerfile = resolve(context, service.build.dockerfile || "Dockerfile");
    assert.ok(statSync(context).isDirectory(), `${name}: build context ${context} is not a directory`);
    assert.ok(statSync(dockerfile).isFile(), `${name}: no Dockerfile at ${dockerfile}`);
  }

  assert.equal(
    read("deploy/up.sh").includes("--project-directory"),
    false,
    "up.sh must not move the project directory — every context above is written relative to deploy/",
  );
});

test("the VPN and the UI are swappable images, not edits to this file", () => {
  assert.match(svc("vpn-sidecar").image, /^\$\{VPN_IMAGE:-/, "VPN_IMAGE overrides the idle default");
  assert.match(svc("dsh").image, /^\$\{DSH_IMAGE:-/, "DSH_IMAGE swaps the stub for the real harness (Epic 5)");
  assert.ok(svc("vpn-sidecar").cap_add.includes("NET_ADMIN"), "a real tunnel needs to create a device");
});

test("US-4.2 + US-4.4: the entrypoint clears a lock from a container that is gone, before serving", () => {
  // The reachable deadlock this prevents: a hard kill (release() never runs), then a recreate, which
  // hands the new container a new id. core-lock refuses that record on principle — it cannot tell a
  // dead foreign holder from a live one. Compose can: `container_name` means only one core exists, so
  // a record naming another container is a container that is gone. Verified against the real stack.
  const entrypoint = read("deploy/core-entrypoint.sh");
  const reapAt = entrypoint.indexOf("reapForeignHostLock");
  const execAt = entrypoint.indexOf("exec node");
  assert.ok(reapAt > -1, "the entrypoint must reap a lock left by a container that no longer exists");
  assert.ok(execAt > -1 && reapAt < execAt, "it must happen BEFORE the server starts, or it is pointless");
});

test("the entrypoint and the launcher are executable, and deploy/ actually ships", () => {
  for (const rel of ["deploy/up.sh", "deploy/core-entrypoint.sh"]) {
    assert.ok(statSync(join(ROOT, rel)).mode & 0o111, `${rel} must be committed with the exec bit set`);
  }
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.files.includes("deploy/"), "the stack is useless to a consumer if it is not published");
});
