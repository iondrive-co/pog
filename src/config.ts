/**
 * Seat and match configuration — the shape the setup UI edits and the Arena
 * turns into a running `Match`. Hosts driving the engine directly don't need
 * any of this.
 */

import type { GameSpec, OptionValues } from "./dsl.js";
import { defaultOptions } from "./dsl.js";

export type SeatKind = "human" | "llm" | "rules";

export interface SeatConfig {
  kind: SeatKind;
  name: string;
  /**
   * For an `llm` seat: the model family it plays with (a WebLLM model_id base,
   * e.g. "Llama-3.2-1B-Instruct" — the f16/f32 build is resolved at load time).
   * Absent = the host's default model. Meaningless on other kinds.
   */
  model?: string;
}

export interface MatchConfig {
  gameId: string;
  options: OptionValues;
  seats: SeatConfig[];
}

export function defaultSeat(index: number, kind: SeatKind): SeatConfig {
  // Name seats "Player N" / "Bot N" rather than the pronoun "You": the games'
  // narration is third-person ("{player} plays", "{player}'s goods"), which a
  // proper noun conjugates cleanly but a pronoun ("You plays", "You's") does
  // not. The 🧑/🤖 badges still mark who is human.
  return {
    kind,
    name: `${kind === "human" ? "Player" : "Bot"} ${index + 1}`,
  };
}

/** True if `name` is still the auto-generated default for either kind at `index`. */
export function isAutoSeatName(name: string, index: number): boolean {
  return name === defaultSeat(index, "human").name || name === defaultSeat(index, "llm").name;
}

/**
 * Make exactly one seat the human (the rest bots) and refresh any still-default
 * names to match — so choosing "you play seat 3" renames "Bot 3" → "Player 3"
 * and the seat you left "Player 1" → "Bot 1", while leaving names you edited alone.
 * A seat that was already a bot keeps its brain (rule-based, or its chosen
 * model); the seat the human vacates becomes a default LLM.
 * Pass an index no seat has (e.g. -1) to make every seat a bot — the spectate case.
 */
export function withHumanSeat(seats: SeatConfig[], humanIndex: number): SeatConfig[] {
  return seats.map((s, i) => {
    const kind: SeatKind = i === humanIndex ? "human" : s.kind === "human" ? "llm" : s.kind;
    const name = isAutoSeatName(s.name, i) ? defaultSeat(i, kind).name : s.name;
    return { kind, name, model: kind === "llm" ? s.model : undefined };
  });
}

/**
 * A fresh config for a game: minimum seats, human in seat 0, bots elsewhere.
 * Bot seats default to the game's own rule-based strategy when it authors one
 * (playable instantly, no model download); otherwise to an LLM on the host's
 * default model. When the game file names its seats (the companies), those
 * names seed the fields instead of "Player N" / "Bot N". A game-authored name
 * isn't an auto name, so `withHumanSeat` keeps it when the human/LLM roles shuffle.
 */
export function defaultMatchConfig(spec: GameSpec<unknown>): MatchConfig {
  const names = spec.seats.names;
  const botKind: SeatKind = spec.bot ? "rules" : "llm";
  return {
    gameId: spec.id,
    options: defaultOptions(spec),
    seats: Array.from({ length: spec.seats.min }, (_, i) => {
      const seat = defaultSeat(i, i === 0 ? "human" : botKind);
      return names?.[i] ? { ...seat, name: names[i] } : seat;
    }),
  };
}
