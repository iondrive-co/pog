// Shared test harness: run a whole match deterministically and capture a stable
// text transcript, so a game's end-to-end behaviour can be locked in a golden
// file. The engine is pure and headless (a `Match` plus scripted `Agent`s), and
// the only randomness — the secret horizon and the `chance(…)` dice — flows
// through `Math.random`, so seeding it makes a run fully reproducible.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import assert from "node:assert/strict";

/** mulberry32: a tiny seeded PRNG. Same seed → same stream, forever. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run `fn` with `Math.random` pinned to a seeded stream, then restore it.
 * `await fn()` (not `return fn()`) so the seed stays installed across the whole
 * async match — the secret horizon is drawn synchronously, but `chance(…)` dice
 * roll later, after awaits, and must draw from the same seeded stream.
 */
export async function withSeededRandom(seed, fn) {
  const real = Math.random;
  Math.random = mulberry32(seed);
  try {
    return await fn();
  } finally {
    Math.random = real;
  }
}

/**
 * Play a whole match with scripted agents and return a normalized transcript:
 * the seats spec, each turn's tag/status and the game's narration, then the
 * winners, verdict, and history table. `policy(seat, round, choices)` returns a
 * choice id (round is 0-based; an illegal id falls back to the first choice).
 */
export async function runMatch(Match, game, names, { policy, options } = {}) {
  const match = new Match(game, names, options);
  const ctx = { round: 0 };
  const agents = Object.fromEntries(
    names.map((_, seat) => [
      seat,
      {
        async choose(req) {
          const want = policy(seat, ctx.round, req.choices);
          const id = req.choices.some((c) => c.id === want) ? want : req.choices[0].id;
          return { choiceId: id, reasoning: "", parseFailed: false };
        },
      },
    ]),
  );

  const s = game.seats;
  const lines = [
    `seats: min=${s.min} max=${s.max}` +
      ` roleNames=${JSON.stringify(s.roleNames)}` +
      ` names=${JSON.stringify(s.names)}` +
      ` descriptions=${JSON.stringify(s.descriptions)}`,
  ];

  while (!match.over) {
    const tag = game.view.turnTag?.(match.state) ?? "";
    const status = game.view.status(match.state);
    const entries = await match.step(agents); // queries agents for ctx.round
    lines.push(`[${tag}] ${status}`);
    for (const e of entries) if (e.kind === "info") lines.push(`  ${e.text}`);
    ctx.round++;
  }

  const oc = match.outcome();
  lines.push(`winners: ${JSON.stringify(oc.winners)}`);
  lines.push(`verdict: ${oc.summary}`);
  const table = game.view.table?.(match.state);
  if (table) {
    lines.push(`table: ${table.columns.join(" | ")}`);
    for (const row of table.rows) lines.push(`  ${row.join(" | ")}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Assert `actual` equals the golden file at `path`. Set `UPDATE_GOLDEN=1` to
 * (re)write goldens instead of asserting — review the diff before committing.
 */
export function checkGolden(path, actual) {
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  assert.ok(
    existsSync(path),
    `Golden file missing: ${path}\nCreate it with: UPDATE_GOLDEN=1 npm test`,
  );
  assert.equal(
    actual,
    readFileSync(path, "utf8"),
    `Transcript differs from golden ${path}.\n` +
      `If this change is intended, regenerate with: UPDATE_GOLDEN=1 npm test`,
  );
}

/** Read a game file relative to a test module's own URL. */
export function readGame(importMetaUrl, relPath) {
  return readFileSync(new URL(relPath, importMetaUrl), "utf8");
}
