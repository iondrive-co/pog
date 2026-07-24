/**
 * The game DSL: everything a turn-based, choice-driven text game needs is
 * declared in one `GameSpec` object — state shape, decision flow, resolution
 * rules, win condition, the prose each seat is shown, and how the match is
 * displayed. The library ships no games; hosts define their own with
 * `defineGame` and hand them to the engine/components.
 *
 * The model:
 * - A game is a pure state machine. `init` builds the starting state;
 *   `decisions` says who must choose what next; `apply` resolves one batch of
 *   picks into the next state.
 * - Every decision is a pick from a predefined list of `choices` — that is
 *   what lets one engine drive humans (buttons) and LLMs (a JSON protocol)
 *   through the same game.
 * - All decisions returned in one `decisions()` batch are made simultaneously:
 *   nobody (human or LLM) sees another's pick before the batch resolves.
 *   Sequential games return their decisions one batch at a time; anything a
 *   later actor should see (e.g. an offer awaiting a response) must be written
 *   into the state and surfaced via `observation`.
 * - An empty `decisions()` batch means the game is over; `outcome` is then
 *   consulted for the verdict.
 */

/** One selectable option in a decision. */
export interface Choice {
  id: string;
  label: string;
  /** Optional extra context, shown to humans as a tooltip and to LLMs inline. */
  detail?: string;
  /**
   * True when this option is currently unavailable — shown to humans greyed out
   * (with `detail` as the reason) and hidden from LLM/bot agents entirely. The
   * engine treats a disabled option as an illegal pick.
   */
  disabled?: boolean;
}

/** One pending decision: `seat` must pick exactly one of `choices`. */
export interface Decision {
  /** Index of the seat that decides. */
  seat: number;
  /** Identifies this decision's pick in the batch handed to `apply`. Must be unique within the batch. */
  key: string;
  /** The question put to the deciding player, e.g. "Choose your move for round 3." */
  prompt: string;
  choices: Choice[];
  /**
   * Authored label for the button that commits this seat's whole batch at once
   * (e.g. "End quarter"), shown when a seat decides several axes together. Only
   * set by multi-axis phases; the host falls back to a generic label otherwise.
   */
  commitLabel?: string;
}

/** A line of narration emitted by `apply`, logged to the match transcript. */
export type GameEvent = string | { author?: string; text: string; tone?: string };

/** A rule-based bot's move: the chosen option and the reasoning it logs. */
export interface BotPick {
  choiceId: string;
  reasoning: string;
}

export interface StepResult<S> {
  state: S;
  /** What the resolved batch did, e.g. "Alice played Rock, Bob played Paper — Bob takes the point." */
  events?: GameEvent[];
}

export interface Outcome {
  /** Human-readable verdict, e.g. "Alice wins 6–4." */
  summary: string;
  /** Winning seat indices; empty for a draw (or a shared defeat). */
  winners: number[];
}

/** A numeric knob the host (or setup UI) can turn, e.g. number of rounds. */
export interface NumberOption {
  kind: "number";
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
}

export type GameOption = NumberOption;
export type OptionValues = Record<string, number | string>;

export interface SeatSpec {
  min: number;
  max: number;
  /** What each seat is called when the seats are asymmetric (e.g. Matcher / Mismatcher). */
  roleNames?: string[];
  /**
   * Default display name for each seat, authored in the game file (e.g. the
   * competing companies). Seeds the setup UI's per-seat name field, which the
   * host may still override. Absent when the game only says how many seats.
   */
  names?: string[];
  /**
   * A one-line description of each named seat, authored in the game file.
   * Cosmetic — shown at setup, not read by any rule.
   */
  descriptions?: string[];
}

export interface InitContext {
  /** Display names of the participating seats, in seat order. */
  seatNames: string[];
  /** Option values, with the spec's defaults already filled in. */
  options: OptionValues;
}

/**
 * One cell of a stats/history table. Usually a bare value; a styled cell
 * carries a `tone` (a CSS-class hint the host renders, e.g. "down" for a value
 * that just fell) and an optional `tip` shown on hover over that cell.
 */
export type TableCell = string | number | { value: string | number; tone?: string; tip?: string };

export interface HistoryTable {
  columns: string[];
  /** Optional hover explanation per column, aligned with `columns`. */
  tips?: (string | undefined)[];
  rows: TableCell[][];
}

/** Display hooks — how a running match is summarized on screen. */
export interface GameView<S> {
  /** Where the match stands, e.g. "Round 3 of 10" — shown in the match header. */
  status(state: S): string;
  /**
   * An optional single figure to spotlight above the match — a label and its
   * current value, e.g. `{ label: "Unit price", value: "20" }`. Rendered large
   * so a number that drives every decision is impossible to miss. An optional
   * `tip` explains the figure on hover.
   */
  headline?(state: S): { label: string; value: string; tip?: string } | null;
  /** Current standing per seat, shown on the scoreboard (numbers or short strings). */
  scores(state: S): (number | string)[];
  /** Short label attached to transcript entries for the current turn, e.g. "R3" or "Q2". */
  turnTag?(state: S): string;
  /**
   * Optional per-seat stats table: one row per seat (in seat order), `columns`
   * naming the stats. Shown in place of the plain scoreboard. Values arrive
   * ready to display — a secret stat is masked here except on the rows listed
   * in `reveal` (the seats watching this screen, e.g. the human players), so
   * a player reads their own secrets straight off the table while rivals'
   * stay hidden.
   */
  seatStats?(state: S, reveal?: number[]): HistoryTable | null;
  /** Optional history table rendered under the match; return null while empty. */
  table?(state: S): HistoryTable | null;
  /** Optional pre-match description of the configured game, shown in the setup panel. */
  setup?(options: OptionValues): string;
}

export interface GameSpec<S> {
  id: string;
  name: string;
  /** One-paragraph pitch shown in the setup panel. */
  blurb: string;
  seats: SeatSpec;
  /** Knobs the host may expose in a setup UI; values reach `init` via `options`. */
  options?: GameOption[];

  /** Build the starting state. Must be a pure function of its context. */
  init(ctx: InitContext): S;
  /**
   * The next batch of decisions, all made simultaneously and resolved together
   * by `apply`. Return them one at a time for sequential play. An empty array
   * means the game is over.
   */
  decisions(state: S): Decision[];
  /** Pure reducer: resolve one batch of picks (keyed by each decision's `key`). */
  apply(state: S, picks: Record<string, string>): StepResult<S>;
  /** The final verdict; only consulted once `decisions()` is empty. */
  outcome(state: S): Outcome;
  /**
   * Optional scripted play: the pick a rule-based (non-LLM) bot makes for one
   * of the current `decisions()`, with the reasoning it logs. Game files author
   * this as a per-phase `bot:` rule list; hand-written specs may implement it
   * directly. Absent when the game defines no bot strategy — hosts should then
   * not offer rule-based seats. Must be pure and must only read what the
   * deciding seat could fairly see.
   */
  bot?(state: S, decision: Decision): BotPick | null;

  /**
   * The standing rules of the game from one seat's perspective — system-prompt
   * material for an LLM in that seat. Write it second person ("You are
   * playing…") and include everything needed to play well: the moves, the
   * payoffs, the win condition.
   */
  rules(state: S, seat: number): string;
  /**
   * What this seat can currently see: history so far, running totals, a
   * pending offer, … Sent to the LLM with every decision; keep hidden
   * information out of the wrong seat's view here.
   */
  observation(state: S, seat: number): string;

  view: GameView<S>;
}

/** Identity helper that pins down the state type parameter for inference. */
export function defineGame<S>(spec: GameSpec<S>): GameSpec<S> {
  return spec;
}

/** The spec's option defaults as a value map. */
export function defaultOptions(spec: GameSpec<unknown>): OptionValues {
  const values: OptionValues = {};
  for (const opt of spec.options ?? []) values[opt.key] = opt.default;
  return values;
}
