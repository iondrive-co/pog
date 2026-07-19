#!/usr/bin/env node
// Interactive dev launcher.
//
// vite.config.ts sets `strictPort: true` so Vite refuses to silently drift to
// another port (which might not be open in a firewall/tunnel/port-forward) and
// instead errors out on a conflict. That's the right default, but the bare
// error is unhelpful — so this wrapper intercepts the conflict and asks whether
// to kill whatever holds the port or start on the next free one, then runs the
// real Vite CLI (config, plugins, HMR, keyboard shortcuts and all).

import { createServer } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_PORT = Number(process.env.PORT) || 5173;
const VITE_BIN = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

/** True if binding `port` on `host` succeeds (host undefined = wildcard). */
function canBind(port, host) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", (err) => resolve(err.code !== "EADDRINUSE"));
    srv.once("listening", () => srv.close(() => resolve(true)));
    if (host === undefined) srv.listen(port);
    else srv.listen(port, host);
  });
}

/**
 * True if `port` is free. Vite's host:true binds the wildcard address, but on
 * Windows a wildcard bind doesn't conflict with an existing loopback-only
 * listener (e.g. another Vite on 127.0.0.1) — so the wildcard probe alone would
 * report the port free while http://localhost still resolves to that other
 * server. Probe 127.0.0.1 explicitly too, and treat the port as busy if either
 * bind fails.
 */
async function isPortFree(port) {
  const [wildcard, loopback] = await Promise.all([canBind(port), canBind(port, "127.0.0.1")]);
  return wildcard && loopback;
}

/**
 * PIDs listening on `port` (best-effort); [] if unknown.
 * Windows: parse `netstat -ano`. POSIX: lsof, then ss.
 */
function listenersOn(port) {
  if (process.platform === "win32") {
    try {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        // TCP  <local>  <foreign>  LISTENING  <pid>
        if (cols.length < 5 || cols[3] !== "LISTENING") continue;
        // local addr is host:port — match the trailing :port exactly (handles
        // 0.0.0.0:, 127.0.0.1:, [::]:, [::1]:).
        if (cols[1].endsWith(`:${port}`)) pids.add(cols[4]);
      }
      return [...pids];
    } catch {}
    return [];
  }
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

async function firstFreePort(start) {
  for (let p = start; p < start + 100; p++) if (await isPortFree(p)) return p;
  throw new Error(`No free port found in ${start}..${start + 99}`);
}

async function waitUntilFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await isPortFree(port)) return true;
    await sleep(150);
  } while (Date.now() < deadline);
  return isPortFree(port);
}

/** Hand off to the real Vite CLI on `port`, inheriting the terminal. */
function runVite(port) {
  const args = [VITE_BIN, "--port", String(port), "--strictPort", ...process.argv.slice(2)];
  const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
}

async function main() {
  let port = DEFAULT_PORT;

  if (await isPortFree(port)) return runVite(port);

  const pids = listenersOn(port);
  const held = pids.length ? ` (held by PID ${pids.join(", ")})` : "";
  console.log(`\n[dev] Port ${port} is already in use${held}.`);

  if (!process.stdin.isTTY) {
    console.error(`[dev] Not an interactive terminal — can't prompt.`);
    console.error(`[dev] Free it (e.g. \`kill ${pids[0] ?? "$(lsof -t -i:" + port + ")"}\`) or set PORT=<other> and retry.\n`);
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (
    await rl.question(`[dev] [k] kill it & use ${port}   [p] start on next free port   [a] abort — choose (k/p/a): `)
  ).trim().toLowerCase();
  rl.close();

  if (answer === "k" || answer === "kill") {
    if (!pids.length) {
      console.error(`[dev] Couldn't identify the process on ${port} (need lsof or ss). Try [p] instead.\n`);
      process.exit(1);
    }
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    if (!(await waitUntilFree(port, 5000))) {
      console.error(`[dev] Port ${port} still busy after signalling ${pids.join(", ")}.\n`);
      process.exit(1);
    }
    console.log(`[dev] Killed ${pids.join(", ")}; starting on ${port}.\n`);
    return runVite(port);
  }

  if (answer === "p" || answer === "port") {
    const next = await firstFreePort(port + 1);
    console.log(`[dev] Starting on ${next}.\n`);
    return runVite(next);
  }

  console.log("[dev] Aborted.\n");
  process.exit(1);
}

main();
