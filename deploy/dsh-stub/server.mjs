// dsh-stub — proves the skills volume is mounted read-only and the UI port is up.
// Not the DeepSeek Harness. Replace this image with DSH_IMAGE (Epic 5).

import { readdirSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8080);
const SKILLS = process.env.SKILLS_DIR || "/skills";
const MCP = process.env.SYNAPSE_MCP_URL || "http://127.0.0.1:3000/mcp";

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/health") {
    let skills = [];
    try { skills = readdirSync(SKILLS); } catch { skills = []; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mcp: MCP, skills, stub: true }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("synapse dsh stub — set DSH_IMAGE for the real UI\n");
});

// Docker publishes this port via BIND_ADDR on the HOST. Inside the container, listen on every
// container interface so the docker-proxy can reach us. That is not a host 0.0.0.0 publish.
server.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`[dsh-stub] ${PORT} · skills=${SKILLS} · mcp=${MCP}\n`);
});
