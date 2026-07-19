// The `bot:` authoring surface — rule-based seats playing a game file's own
// authored strategy — exercised through the built output like every other
// test: parse-time validation, pick selection, `say` reasoning, and the
// ruleAgent driving a whole match without any model.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGame } from "../dist/gamefile.js";
import { Match, ruleAgent } from "../dist/engine.js";

// Two seats, three rounds: seat cash starts asymmetric so a threshold rule
// splits the seats, and `save` pays more so the match has a decided outcome.
const gameWith = (botBlocks) => `
id: t
name: T
seats: 2
rounds: 3
state: { cash: { per seat: [0, 30] } }
phases:
  - phase: move
    ask: "go"
    choices: [ { id: spend, label: SPEND }, { id: save, label: SAVE } ]
    ${botBlocks.move ?? ""}
    resolve:
      - each seat:
          - when: { move: save }
            do: [ "cash += 10" ]
          - when: { move: spend }
            do: [ "cash += 5" ]
  - phase: talk
    ask: "say"
    choices: [ { id: brag, label: BRAG }, { id: quiet, label: QUIET } ]
    ${botBlocks.talk ?? ""}
outcome: { score: cash, per: seat, win: highest, verdict: "{player} wins with {cash}", draw: "tie" }
rules: "r"
observation: [ { line: "o" } ]
view: { status: "s", turn tag: "T" }
`;

const MOVE_BOT = `bot:
      - when: "cash >= 30"
        pick: save
        say: "Sitting on {cash} — saving."
      - pick: spend`;
const TALK_BOT = `bot:
      - pick: quiet`;

test("bot: the first matching rule picks, and its say renders for the seat", () => {
  const game = parseGame(gameWith({ move: MOVE_BOT, talk: TALK_BOT }));
  const state = game.init({ seatNames: ["A", "B"], options: {} });
  const [d0, d1] = game.decisions(state);
  // Seat 0 (cash 0) falls through to the unconditional rule, no reasoning.
  assert.deepEqual(game.bot(state, d0), { choiceId: "spend", reasoning: "" });
  // Seat 1 (cash 30) hits the threshold rule, with the rendered say.
  assert.deepEqual(game.bot(state, d1), { choiceId: "save", reasoning: "Sitting on 30 — saving." });
});

test("bot: absent when the game authors no rules", () => {
  const game = parseGame(gameWith({}));
  assert.equal(game.bot, undefined);
});

test("bot: ruleAgent plays a whole match, logging says as reasoning", async () => {
  const game = parseGame(gameWith({ move: MOVE_BOT, talk: TALK_BOT }));
  const match = new Match(game, ["A", "B"]);
  const agents = {
    0: ruleAgent(game, () => match.state),
    1: ruleAgent(game, () => match.state),
  };
  const reasonings = [];
  while (!match.over) {
    for (const e of await match.step(agents)) {
      assert.notEqual(e.kind, "error", `no step should fall back: ${e.text}`);
      if (e.kind === "reasoning" && e.text) reasonings.push(`${e.author}: ${e.text}`);
    }
  }
  // Seat 1 saves every round (starts at 30); seat 0 spends until its cash
  // crosses the threshold. Deterministic — no dice in this game.
  assert.equal(match.outcome().summary, "B wins with 60");
  assert.ok(reasonings.includes("B: Sitting on 30 — saving."));
});

test("bot: ruleAgent falls back to a flagged random pick without rules", async () => {
  const game = parseGame(gameWith({}));
  const match = new Match(game, ["A", "B"]);
  const agent = ruleAgent(game, () => match.state);
  const entries = await match.step({ 0: agent, 1: agent });
  assert.ok(entries.some((e) => e.kind === "error" && /no bot rule/.test(e.text)));
});

// --- Parse-time validation --------------------------------------------------

test("bot: pick must name a choice id of the phase", () => {
  assert.throws(
    () => parseGame(gameWith({ move: `bot:\n      - pick: nope`, talk: TALK_BOT })),
    /"nope" is not a choice id/,
  );
});

test("bot: the last rule must be unconditional", () => {
  const conditional = `bot:
      - when: "cash >= 30"
        pick: save`;
  assert.throws(
    () => parseGame(gameWith({ move: conditional, talk: TALK_BOT })),
    /last bot rule must have no "when"/,
  );
});

test("bot: rules must cover every phase or none", () => {
  assert.throws(() => parseGame(gameWith({ move: MOVE_BOT })), /must cover every phase\/axis or none.*"talk"/);
});
