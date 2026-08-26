#!/usr/bin/env node
// assert-bind.mjs — refuse a compose/host bind that would publish on every interface.
//
// Docker `ports: ["${BIND_ADDR}:8080:8080"]` is only as safe as BIND_ADDR. 0.0.0.0 here would put
// the UI on the public host interface, which [[doc-deployment-gate]] forbids. Same wildcard set as
// the HTTP MCP listener, so the two paths cannot drift.

import { assertSafeHttpBindHost } from "../lib/ports/index.mjs";

const addr = process.argv[2] || process.env.BIND_ADDR || "";
try {
  const bound = assertSafeHttpBindHost(addr);
  if (process.argv.includes("--print")) process.stdout.write(`${bound}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
