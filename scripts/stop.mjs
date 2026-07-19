#!/usr/bin/env node
// Stop the pog dev server: find whatever is listening on the dev port and
// signal it to shut down. Mirrors the port-detection in scripts/dev.mjs.
//
//   npm run stop            # stops the server on the default port (5173)
//   PORT=5200 npm run stop  # …or on the port dev was started with

import { execFileSync } from "node:child_process";

const PORT = Number(process.env.PORT) || 5173;

/** PIDs listening on `port` (best-effort via lsof, then ss); [] if unknown. */
function listenersOn(port) {
  try {
    const out = execFileSync("lsof", ["-i", `:${port}`, "-sTCP:LISTEN", "-t", "-P", "-n"], { encoding: "utf8" });
    return [...new Set(out.split(/\s+/).filter(Boolean))];
  } catch {}
  try {
    const out = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
    return [...new Set([...out.matchAll(/pid=(\d+)/g)].map((m) => m[1]))];
  } catch {}
  return [];
}

const pids = listenersOn(PORT);
if (!pids.length) {
  console.log(`[stop] Nothing is listening on port ${PORT}.`);
  process.exit(0);
}

const killed = [];
for (const pid of pids) {
  try {
    process.kill(Number(pid), "SIGTERM");
    killed.push(pid);
  } catch {
    /* already gone */
  }
}
console.log(`[stop] Sent SIGTERM to PID ${killed.join(", ")} on port ${PORT}.`);
