// The engine's fail-soft guarantees: a crashing agent (a lost GPU device, a
// dead backend) must never abort a step or wedge a match. Each failed decision
// falls back to a random legal pick with the cause flagged in the transcript,
// and the match plays through to a verdict. This is the regression net for the
// in-browser failure mode where WebGPU dies mid-generation ("Buffer unmapped")
// and every later request throws ModelNotLoadedError.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGame } from "../dist/gamefile.js";
import { Match } from "../dist/engine.js";

const GAME = `
id: t
name: T
seats: 2
rounds: 3
state: { cash: { per seat: 0 } }
phases:
  - phase: move
    ask: "go"
    choices: [ { id: a, label: A }, { id: b, label: B } ]
    resolve:
      - each seat:
          - "cash += 1"
outcome: { score: cash, per: seat, win: highest, verdict: "{player} wins", draw: "tie" }
rules: "r"
observation: [ { line: "o" } ]
view: { status: "s", turn tag: "T" }
`;

const fine = { async choose(req) { return { choiceId: req.choices[0].id, reasoning: "ok", parseFailed: false }; } };
const dead = {
  async choose() {
    throw new Error("AbortError: Buffer unmapped");
  },
};

test("failsoft: a crashing agent costs one decision, not the step", async () => {
  const match = new Match(parseGame(GAME), ["A", "B"]);
  const entries = await match.step({ 0: fine, 1: dead });
  const flagged = entries.filter((e) => e.kind === "error");
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].author, "B");
  assert.match(flagged[0].text, /agent failed — .*Buffer unmapped.*random choice was played/);
  // The step resolved: state advanced for both seats.
  assert.deepEqual(match.state.perSeat.map((s) => s.cash), [1, 1]);
});

test("failsoft: a match whose agents always crash still reaches a verdict", async () => {
  const match = new Match(parseGame(GAME), ["A", "B"]);
  while (!match.over) {
    const entries = await match.step({ 0: dead, 1: dead });
    assert.ok(entries.some((e) => e.kind === "error"), "every step should flag the failures");
  }
  assert.match(match.outcome().summary, /wins|tie/);
});
