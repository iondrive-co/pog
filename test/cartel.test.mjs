// Regression tests for the pog engine, exercised through its built output
// (`dist/`, which is what consumers import). Two things are covered:
//   1. A deterministic full match of the demo game (Cartel) locked to a golden
//      transcript — the canary that engine changes don't silently alter play.
//   2. The `seats` authoring surface: a plain count vs. a named-company list,
//      and how names seed the setup config.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { parseGame } from "../dist/gamefile.js";
import { Match } from "../dist/engine.js";
import { defaultMatchConfig, withHumanSeat } from "../dist/config.js";
import { runMatch, withSeededRandom, checkGolden, readGame } from "./harness.mjs";

const golden = (name) => fileURLToPath(new URL(`./golden/${name}`, import.meta.url));

test("cartel: full match matches golden transcript", async () => {
  const game = parseGame(readGame(import.meta.url, "../demo/games/cartel.yaml"));
  const names = ["Alice", "Bob", "Carol", "Dave"];
  // Even seats flood, odd seats withhold — a fixed pattern that drives the
  // price down and exercises markdown, team totals, and the draw verdict.
  const policy = (seat) => (seat % 2 === 0 ? "flood" : "withhold");
  const transcript = await withSeededRandom(20260714, () => runMatch(Match, game, names, { policy }));
  checkGolden(golden("cartel.txt"), transcript);
});

// --- The `seats` authoring surface -----------------------------------------

const minimalGame = (seatsBlock) => `
id: t
name: T
${seatsBlock}
rounds: 3
state: { cash: { per seat: 0 } }
phases:
  - phase: move
    ask: "go"
    choices: [ { id: a, label: A }, { id: b, label: B } ]
outcome: { score: cash, per: seat, win: highest, verdict: "{player}", draw: "tie" }
rules: "r"
observation: [ { line: "o" } ]
view: { status: "s", turn tag: "T" }
`;

test("seats: a plain count leaves names/descriptions unset", () => {
  const g = parseGame(minimalGame("seats: 3"));
  assert.equal(g.seats.min, 3);
  assert.equal(g.seats.max, 3);
  assert.equal(g.seats.names, undefined);
  assert.equal(g.seats.descriptions, undefined);
});

test("seats: a named list sets the count, names, and descriptions", () => {
  const g = parseGame(
    minimalGame(`seats:
  - { name: OpenBrain, description: "the pioneer" }
  - { name: DeepCent }`),
  );
  assert.equal(g.seats.min, 2);
  assert.equal(g.seats.max, 2);
  assert.deepEqual(g.seats.names, ["OpenBrain", "DeepCent"]);
  // A missing description is kept as "" so the arrays stay seat-aligned.
  assert.deepEqual(g.seats.descriptions, ["the pioneer", ""]);
});

test("seats: named list seeds the default config and survives a human shuffle", () => {
  const g = parseGame(
    minimalGame(`seats:
  - { name: OpenBrain }
  - { name: DeepCent }
  - { name: Anthropic }`),
  );
  const cfg = defaultMatchConfig(g);
  assert.deepEqual(
    cfg.seats.map((s) => [s.kind, s.name]),
    [
      ["human", "OpenBrain"],
      ["llm", "DeepCent"],
      ["llm", "Anthropic"],
    ],
  );
  // Company names aren't auto "Player N"/"Bot N" names, so moving the human
  // seat must not rename anyone.
  const shuffled = withHumanSeat(cfg.seats, 2);
  assert.deepEqual(
    shuffled.map((s) => [s.kind, s.name]),
    [
      ["llm", "OpenBrain"],
      ["llm", "DeepCent"],
      ["human", "Anthropic"],
    ],
  );
});

test("seats: spectate (humanIndex -1) makes every seat a bot", () => {
  // Named seats keep their company names when nobody is human.
  const named = parseGame(
    minimalGame(`seats:
  - { name: OpenBrain }
  - { name: DeepCent }`),
  );
  const spectating = withHumanSeat(defaultMatchConfig(named).seats, -1);
  assert.deepEqual(
    spectating.map((s) => [s.kind, s.name]),
    [
      ["llm", "OpenBrain"],
      ["llm", "DeepCent"],
    ],
  );
  // A default "Player 1" human seat reverts to the bot name "Bot 1".
  const numbered = parseGame(minimalGame("seats: 2"));
  const specNumbered = withHumanSeat(defaultMatchConfig(numbered).seats, -1);
  assert.deepEqual(
    specNumbered.map((s) => [s.kind, s.name]),
    [
      ["llm", "Bot 1"],
      ["llm", "Bot 2"],
    ],
  );
});

test("seats: a list entry without a name is a plain-English error", () => {
  assert.throws(
    () => parseGame(minimalGame(`seats:\n  - { description: "no name here" }`)),
    /seat 1 needs a "name"/,
  );
});
