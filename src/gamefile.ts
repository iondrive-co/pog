/**
 * Game files — a whole game described as one editable YAML (or JSON) document.
 * `parseGame` compiles such a document into a runnable `GameSpec`; everything
 * the engine needs, including the rules text and running state shown to LLM
 * seats, is generated from the file, so an edit changes the game faithfully.
 *
 * The format is a small state machine:
 * - `seats` producers, optionally grouped into `teams`;
 * - named `state` numbers (global, or `per seat`) with formula initial values;
 * - `derive`d values — formulas recomputed on demand (markets, prices, tallies);
 * - a round is an ordered list of `phases`, each a simultaneous batch where
 *   every seat picks at once; when its last phase resolves the round is banked;
 * - a phase may carry a `resolve` block: assignments and narration run
 *   top-to-bottom over the state after everyone has picked;
 * - `outcome`, `rules`, `observation`, and `view` are authored templates.
 *
 * The authoring guide is RULES.md; demo/games/cartel.yaml is the worked example.
 */

import { parse as parseYAML } from "yaml";
import type { BotPick, Choice, Decision, GameOption, GameSpec, Outcome, StepResult } from "./dsl.js";

// ---------------------------------------------------------------------------
// Tiny arithmetic expressions: numbers, (multi-word) names, + - * / , unary -,
// parentheses, and function calls (min, max, clamp, recent, tally).

type Expr =
  | { kind: "num"; value: number }
  | { kind: "name"; name: string }
  | { kind: "neg"; arg: Expr }
  | { kind: "bin"; op: "+" | "-" | "*" | "/"; left: Expr; right: Expr }
  | { kind: "call"; fn: string; args: Expr[] };

/**
 * Split a formula into tokens. Names may contain spaces ("flood markdown"), so
 * `vocab` lists the known multi-word names and the longest matching one wins;
 * anything else falls back to a single word.
 */
function tokenize(src: string, vocab: string[]): string[] {
  const multi = vocab.filter((n) => /\s/.test(n)).sort((a, b) => b.length - a.length);
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if ("()+-*/,".includes(ch)) {
      tokens.push(ch);
      i++;
    } else if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push(src.slice(i, j));
      i = j;
    } else if (/[A-Za-z_]/.test(ch)) {
      const name = multi.find((n) => src.startsWith(n, i) && !/[A-Za-z0-9_]/.test(src[i + n.length] ?? ""));
      if (name) {
        tokens.push(name);
        i += name.length;
      } else {
        let j = i;
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
        tokens.push(src.slice(i, j));
        i = j;
      }
    } else {
      throw new Error(`cannot read "${src}" from character ${i + 1}`);
    }
  }
  return tokens;
}

function parseExpr(src: string, vocab: string[]): Expr {
  const tokens = tokenize(src, vocab);
  let i = 0;
  const isName = (t: string): boolean => /[A-Za-z_]/.test(t[0] ?? "");
  function atom(): Expr {
    const t = tokens[i++];
    if (t === undefined) throw new Error(`"${src}" ends unexpectedly`);
    if (t === "(") {
      const e = sum();
      if (tokens[i++] !== ")") throw new Error(`missing ")" in "${src}"`);
      return e;
    }
    if (t === "-") return { kind: "neg", arg: atom() };
    if (/^[0-9]/.test(t)) return { kind: "num", value: Number(t) };
    if (isName(t)) {
      if (tokens[i] === "(") {
        i++;
        const args: Expr[] = [];
        if (tokens[i] !== ")") {
          args.push(sum());
          while (tokens[i] === ",") {
            i++;
            args.push(sum());
          }
        }
        if (tokens[i++] !== ")") throw new Error(`missing ")" after ${t}(… in "${src}"`);
        return { kind: "call", fn: t, args };
      }
      return { kind: "name", name: t };
    }
    throw new Error(`unexpected "${t}" in "${src}"`);
  }
  function product(): Expr {
    let e = atom();
    while (tokens[i] === "*" || tokens[i] === "/") {
      const op = tokens[i++] as "*" | "/";
      e = { kind: "bin", op, left: e, right: atom() };
    }
    return e;
  }
  function sum(): Expr {
    let e = product();
    while (tokens[i] === "+" || tokens[i] === "-") {
      const op = tokens[i++] as "+" | "-";
      e = { kind: "bin", op, left: e, right: product() };
    }
    return e;
  }
  const e = sum();
  if (i < tokens.length) throw new Error(`unexpected "${tokens[i]}" in "${src}"`);
  return e;
}

/** Everything a formula can read: numeric names, text names, and the built-ins. */
interface Env {
  num(name: string): number;
  text(name: string): string | undefined;
  call(fn: string, args: Expr[]): number;
  /** Evaluate a formula from raw source (used by the template renderer). */
  formula(src: string): number;
}

function nameOf(e: Expr): string {
  if (e.kind !== "name") throw new Error("expected a phase or choice name here");
  return e.name;
}

function evalExpr(e: Expr, env: Env): number {
  switch (e.kind) {
    case "num":
      return e.value;
    case "name":
      return env.num(e.name);
    case "neg":
      return -evalExpr(e.arg, env);
    case "bin": {
      const l = evalExpr(e.left, env);
      const r = evalExpr(e.right, env);
      return e.op === "+" ? l + r : e.op === "-" ? l - r : e.op === "*" ? l * r : l / r;
    }
    case "call":
      return env.call(e.fn, e.args);
  }
}

// ---------------------------------------------------------------------------
// {placeholder} templates. A key is a direct text lookup ("player", "list"),
// a formula over the numeric names ("units * your price"), or a formula with a
// leading "+" that renders its result with an explicit sign ("{+profit}").

const PLACEHOLDER = /\{([^{}]+)\}/g;

/**
 * Numbers are floats viewed at one decimal of precision: rendered rounded to
 * 1dp, whole values shown bare ("12", "11.6" — never "12.0").
 */
function fmt(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${fmt(n)}`;
}

function render(tpl: string, env: Env): string {
  return tpl.replace(PLACEHOLDER, (_, raw: string) => {
    const key = raw.trim();
    if (key.startsWith("+")) return signed(env.formula(key.slice(1).trim()));
    const t = env.text(key);
    if (t !== undefined) return t;
    return fmt(env.formula(key));
  });
}

// ---------------------------------------------------------------------------
// Compiled model.

interface ChoiceDef {
  id: string;
  label: string;
  note?: string;
  /**
   * When present and true (for the deciding seat), the option is unavailable:
   * greyed for humans (with `disabledNote` as the tooltip reason), hidden from
   * LLM/bot agents. A condition string, evaluated like an observation `when`.
   */
  disabledWhen?: string;
  /** The reason shown when the option is disabled (a `{placeholder}` template). */
  disabledNote?: string;
  /** Extra numeric fields carried by the choice, e.g. `units: 10`. */
  nums: Record<string, number>;
  /** Extra text fields, e.g. `say:` / `past:`. */
  texts: Record<string, string>;
}

type Stmt =
  | { kind: "assign"; target: string; op: "=" | "+=" | "-="; expr: Expr }
  | { kind: "say"; when: WhenClause; template: string; list?: ListSpec }
  | { kind: "when"; when: WhenClause; body: Stmt[] }
  | { kind: "each"; body: Stmt[] };

/** Builds a `{list}` by rendering `each` for every seat (optionally filtered). */
interface ListSpec {
  where?: string;
  each: string;
  join: string;
}

/** Conditions on this round's picks: [phaseKey, one-of choiceIds]. */
type WhenClause = [phase: string, choices: string[]][];

/**
 * One rule of a phase's authored bot strategy: play `pick` when every `when`
 * condition holds (an empty list always holds), logging the rendered `say` as
 * the bot's reasoning. Rules are tried top-to-bottom; the last one of a phase
 * is required to be unconditional, so a rule-based seat always has a move.
 */
interface BotRuleDef {
  when: string[];
  pick: string;
  say?: string;
}

/**
 * One decision axis. A plain `phase` compiles to a single axis (its own key);
 * a phase authored with `axes` compiles to one internal `PhaseDef` per axis,
 * all grouped into a single simultaneous batch (see `Model.batches`). The
 * group's `resolve`/`noneSaid` ride on the batch's last axis, so it runs once,
 * after every axis in the batch has been recorded.
 */
interface PhaseDef {
  key: string;
  ask: string;
  choices: ChoiceDef[];
  /** Emitted when a whole phase resolves and nobody had a `say`. */
  noneSaid?: string;
  resolve: Stmt[];
  /** The phase's rule-based strategy; empty when the game authors none. */
  bot: BotRuleDef[];
  /** Label for the button that commits a multi-axis batch at once, e.g. "End quarter". */
  commit?: string;
}

interface VarDef {
  name: string;
  init: Expr;
  /** Per-seat initial values when authored as a list — one formula per seat. */
  inits?: Expr[];
}

interface DeriveDef {
  name: string;
  scope: "global" | "seat";
  expr: Expr;
}

interface ObsLine {
  when?: string;
  template: string;
  list?: ListSpec;
}

interface TeamDef {
  name: string;
  /** 0-based seat indices. */
  seats: number[];
}

/** One outcome verdict: used when `when` holds (or unconditionally without one). */
interface VerdictDef {
  when?: string;
  text: string;
}

interface Model {
  id: string;
  name: string;
  blurb: string;
  seatCount: number;
  /** Authored default seat names (the companies), or null when `seats` is just a count. */
  seatNames: string[] | null;
  /** Authored per-seat descriptions, aligned with `seatNames`; entries may be "". */
  seatDescriptions: string[] | null;
  teams: TeamDef[];
  constants: Record<string, number>;
  endWindow: number;
  fixedRounds: number | null;
  roundsOption: GameOption | null;
  globals: VarDef[];
  perSeat: VarDef[];
  derives: DeriveDef[];
  /** Internal phases, one per axis, flattened in decision order. */
  phases: PhaseDef[];
  /**
   * How the phases group into simultaneous decision batches: each entry lists
   * the `phases` indices decided together (a plain phase is a batch of one; a
   * multi-axis phase is a batch of several). One `apply` resolves a whole batch.
   */
  batches: number[][];
  scoreVar: string;
  scorePerTeam: boolean;
  winHighest: boolean;
  verdicts: VerdictDef[];
  draws: VerdictDef[];
  /** Optional condition that ends the game at once when it holds. */
  endWhen: string | null;
  /** Resolve steps run exactly once, when the match has just ended. */
  atEnd: Stmt[];
  rules: string;
  observation: ObsLine[];
  view: {
    status: string;
    turnTag: string;
    headlineLabel?: string;
    headlineValue?: string;
    /** Hover explanation of the headline figure (plain text, not a template). */
    headlineTip?: string;
    tableColumns: string[];
    tableCells: string[];
    /**
     * Per-seat stat columns; `secret` ones are masked except on revealed rows,
     * rendering the authored `masked` template (or "?") instead. A `tip`
     * explains the column on hover.
     */
    seatStats: { label: string; value: string; secret: boolean; masked?: string; map?: string[]; tip?: string }[];
  };
  vocab: string[];
}

// ---------------------------------------------------------------------------
// Runtime state.

type SeatVars = Record<string, number>;

interface RoundRow {
  /** All phases' picks this round, keyed "<phase>:<seat>". */
  picks: Record<string, string>;
  globals: Record<string, number>;
  perSeat: SeatVars[];
}

export interface GameFileState {
  names: string[];
  roundsMax: number;
  /** The secret true final round, drawn at init; never shown to anyone. */
  endsAt: number;
  globals: Record<string, number>;
  perSeat: SeatVars[];
  /** The round in progress: phases resolved so far, keyed "<phase>:<seat>". */
  picks: Record<string, string>;
  history: RoundRow[];
}

/** A read-only snapshot the environment resolves names against. */
interface View {
  names: string[];
  globals: Record<string, number>;
  perSeat: SeatVars[];
  history: RoundRow[];
  roundsMax: number;
}

interface Ctx {
  seat?: number;
  round: number;
  picks?: Record<string, string>;
  /** The phase whose decision/resolve this is (for `tally`, `{choice}`). */
  phase?: string;
  /** True only while a phase's `resolve` runs — gates `chance(…)`. */
  resolving?: boolean;
  extraTexts?: Record<string, string>;
  listString?: string;
}

// ---------------------------------------------------------------------------
// The environment: resolve a name to a number or a string against a View + Ctx.

function makeEnv(model: Model, view: View, ctx: Ctx): Env {
  const seatsOfTeam = (t: number): number[] => model.teams[t]?.seats ?? [];
  const teamOf = (seat: number): number => model.teams.findIndex((t) => t.seats.includes(seat));
  const globalName = new Set(model.globals.map((g) => g.name));
  const perSeatName = new Set(model.perSeat.map((v) => v.name));
  const deriveMemo = new Map<string, number>();
  const inProgress = new Set<string>();

  const call = (fn: string, args: Expr[]): number => {
    const ev = (e: Expr): number => evalExpr(e, env);
    switch (fn) {
      case "min":
        return Math.min(...args.map(ev));
      case "max":
        return Math.max(...args.map(ev));
      case "clamp": {
        const [x, lo, hi] = args.map(ev);
        return Math.min(hi, Math.max(lo, x));
      }
      case "floor":
        return Math.floor(ev(args[0]));
      case "chance": {
        // Fresh dice on every call, so it is only legal while a phase resolves:
        // roll once into a state value there, and read that value everywhere
        // else (observations and views must never re-roll history).
        if (!ctx.resolving) {
          throw new Error(`"chance(…)" only rolls while a phase resolves — assign it to a state value in "resolve" and read that`);
        }
        return Math.random() * 100 < ev(args[0]) ? 1 : 0;
      }
      case "recent": {
        if (ctx.seat === undefined) throw new Error(`"recent(…)" needs a seat`);
        const phase = nameOf(args[0]);
        const choice = nameOf(args[1]);
        const window = args[2] ? ev(args[2]) : Infinity;
        if (window <= 0) return 0;
        const rows = window === Infinity ? view.history : view.history.slice(-window);
        return rows.filter((r) => r.picks[`${phase}:${ctx.seat}`] === choice).length;
      }
      case "tally": {
        if (!ctx.phase) throw new Error(`"tally(…)" is only available while a phase resolves`);
        const choice = nameOf(args[0]);
        let n = 0;
        for (let s = 0; s < model.seatCount; s++) if (ctx.picks?.[`${ctx.phase}:${s}`] === choice) n++;
        return n;
      }
      default:
        throw new Error(`unknown function "${fn}(…)"`);
    }
  };

  const evalDerive = (d: DeriveDef): number => {
    const key = `${d.name}@${d.scope === "seat" ? ctx.seat : "*"}`;
    const cached = deriveMemo.get(key);
    if (cached !== undefined) return cached;
    if (inProgress.has(key)) throw new Error(`derived value "${d.name}" refers to itself`);
    inProgress.add(key);
    const v = evalExpr(d.expr, env);
    inProgress.delete(key);
    deriveMemo.set(key, v);
    return v;
  };

  const choiceOf = (phase: string, seat: number): ChoiceDef | undefined => {
    const id = ctx.picks?.[`${phase}:${seat}`];
    if (id === undefined) return undefined;
    return model.phases.find((p) => p.key === phase)?.choices.find((c) => c.id === id);
  };

  const num = (name: string): number => {
    if (name in model.constants) return model.constants[name];
    if (name === "round") return ctx.round;
    if (name === "rounds") return view.roundsMax;
    if (name === "end window") return model.endWindow;
    if (globalName.has(name)) return view.globals[name];
    if (ctx.seat !== undefined) {
      if (perSeatName.has(name)) return view.perSeat[ctx.seat][name];
      for (const p of model.phases) {
        const c = choiceOf(p.key, ctx.seat);
        if (c && name in c.nums) return c.nums[name];
      }
    }
    const d = model.derives.find((x) => x.name === name);
    if (d) {
      if (d.scope === "seat" && ctx.seat === undefined) throw new Error(`"${name}" needs a seat`);
      return evalDerive(d);
    }
    throw new Error(`the game file asks for "{${name}}", which is not a number available here`);
  };

  const teamSum = (t: number, v: string): number =>
    seatsOfTeam(t).reduce((s, seat) => s + view.perSeat[seat][v], 0);

  /** Options of a phase written out as "LABEL — note; …" for the rules text. */
  const optionsText = (phase: PhaseDef): string =>
    phase.choices.map((c) => (c.note ? `${c.label} — ${render(c.note, env)}` : c.label)).join("; ");

  const text = (name: string): string | undefined => {
    if (ctx.extraTexts && name in ctx.extraTexts) return ctx.extraTexts[name];
    if (name === "list") return ctx.listString;

    // Written-out choice lists for the rules: {options} (last phase) / {<phase> options}.
    if (name === "options") return optionsText(model.phases[model.phases.length - 1]);
    let m = name.match(/^(\w+) options$/);
    if (m) {
      const p = model.phases.find((x) => x.key === m![1]);
      if (p) return optionsText(p);
    }

    // Absolute team names / totals: {team 1 name}, {team 2 cash}.
    m = name.match(/^team (\d+) (.+)$/);
    if (m) {
      const t = Number(m[1]) - 1;
      if (t < 0 || t >= model.teams.length) return undefined;
      return m[2] === "name" ? model.teams[t].name : fmt(teamSum(t, m[2]));
    }

    if (ctx.seat !== undefined) {
      const seat = ctx.seat;
      if (name === "player") return view.names[seat];
      if (name === "choice" && ctx.phase) return choiceOf(ctx.phase, seat)?.label;

      // Team-relative names and totals, relative to the observing seat.
      const myTeam = teamOf(seat);
      const otherTeam = model.teams.length === 2 ? 1 - myTeam : -1;
      const teammate = seatsOfTeam(myTeam).find((s) => s !== seat);
      const rivals = otherTeam >= 0 ? seatsOfTeam(otherTeam) : [];
      if (name === "teammate" && teammate !== undefined) return view.names[teammate];
      if (name === "rival 1" && rivals[0] !== undefined) return view.names[rivals[0]];
      if (name === "rival 2" && rivals[1] !== undefined) return view.names[rivals[1]];
      if (name === "your team" && myTeam >= 0) return model.teams[myTeam].name;
      if (name === "their team" && otherTeam >= 0) return model.teams[otherTeam].name;
      const rel = (prefix: string): string | undefined => {
        if (!name.startsWith(prefix + " ")) return undefined;
        const v = name.slice(prefix.length + 1);
        return perSeatName.has(v) ? v : undefined;
      };
      let v: string | undefined;
      if ((v = rel("teammate")) && teammate !== undefined) return fmt(view.perSeat[teammate][v]);
      if ((v = rel("rival 1")) && rivals[0] !== undefined) return fmt(view.perSeat[rivals[0]][v]);
      if ((v = rel("rival 2")) && rivals[1] !== undefined) return fmt(view.perSeat[rivals[1]][v]);
      if ((v = rel("your team")) && myTeam >= 0) return fmt(teamSum(myTeam, v));
      if ((v = rel("rival team")) && otherTeam >= 0) return fmt(teamSum(otherTeam, v));

      // Choice text fields: {signal.say}, {last(move).past}.
      m = name.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
      if (m) {
        const c = choiceOf(m[1], seat);
        const val = c?.texts[m[2]];
        return val === undefined ? "" : render(val, env);
      }
      m = name.match(/^last\(([A-Za-z_]\w*)\)\.([A-Za-z_]\w*)$/);
      if (m) {
        const last = view.history[view.history.length - 1];
        const id = last?.picks[`${m[1]}:${seat}`];
        const c = model.phases.find((p) => p.key === m![1])?.choices.find((x) => x.id === id);
        return c?.texts[m[2]] ?? "";
      }
    }
    return undefined;
  };

  const env: Env = {
    num,
    text,
    call,
    formula: (src) => evalExpr(parseExpr(src, model.vocab), env),
  };
  return env;
}

// ---------------------------------------------------------------------------
// Conditions used by `when:` on observation lines and list filters.

const CMP = /^(.+?)\s*(>=|<=|==|!=|>|<)\s*(.+)$/;

function compare(op: string, l: number, r: number): boolean {
  switch (op) {
    case ">":
      return l > r;
    case "<":
      return l < r;
    case ">=":
      return l >= r;
    case "<=":
      return l <= r;
    case "==":
      return l === r;
    default:
      return l !== r;
  }
}

/** True if `cond` holds. Supports "phase == X", "any seat: …", "a > b", "signal.say". */
function condHolds(
  cond: string,
  model: Model,
  view: View,
  seat: number,
  round: number,
  phase: string,
  picks: Record<string, string>,
): boolean {
  const c = cond.trim();
  let m = c.match(/^phase\s*==\s*(\w+)$/);
  if (m) return phase === m[1];
  m = c.match(/^any seat:\s*(.+)$/);
  if (m) {
    for (let s = 0; s < model.seatCount; s++) {
      if (truthy(m[1], makeEnv(model, view, { seat: s, round, picks, phase }))) return true;
    }
    return false;
  }
  return truthy(c, makeEnv(model, view, { seat, round, picks, phase }));
}

/** A comparison, or a bare name/formula that is "true" when non-empty / non-zero. */
function truthy(cond: string, env: Env): boolean {
  const m = cond.match(CMP);
  if (m) return compare(m[2], env.formula(m[1].trim()), env.formula(m[3].trim()));
  const t = env.text(cond.trim());
  if (t !== undefined) return t.trim().length > 0;
  return env.formula(cond.trim()) !== 0;
}

// ---------------------------------------------------------------------------
// Parsing / validation: document → Model.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalize(doc: unknown): Model {
  const fail = (msg: string): never => {
    throw new Error(`Game file: ${msg}`);
  };
  if (!isRecord(doc)) return fail("the file must be a set of `key: value` entries");

  const reqStr = (key: string, hint: string): string => {
    if (typeof doc[key] !== "string" || !(doc[key] as string).trim()) return fail(`"${key}" is required — ${hint}`);
    return (doc[key] as string).trim();
  };

  const id = reqStr("id", "a short word identifying the game, e.g. cartel");
  const name = reqStr("name", "the game's display name");

  const constants: Record<string, number> = {};
  if (doc.constants !== undefined) {
    if (!isRecord(doc.constants)) return fail(`"constants" must be a set of \`name: number\` entries`);
    for (const [k, v] of Object.entries(doc.constants)) {
      if (typeof v !== "number") return fail(`constant "${k}" must be a number`);
      constants[k] = v;
    }
  }

  // `seats` is either a plain count (`seats: 4`) or a list of named players —
  // `- { name: OpenBrain, description: … }` — whose length IS the count. The
  // names seed the setup UI; the descriptions are cosmetic. Either way the game
  // ends up with a fixed number of seats.
  let seatCount: number;
  let seatNames: string[] | null = null;
  let seatDescriptions: string[] | null = null;
  if (Array.isArray(doc.seats)) {
    if (doc.seats.length < 1) return fail(`"seats" list needs at least one player`);
    seatNames = [];
    seatDescriptions = [];
    doc.seats.forEach((s, i) => {
      if (!isRecord(s) || typeof s.name !== "string" || s.name.trim() === "") {
        return fail(`seat ${i + 1} needs a "name", e.g. { name: OpenBrain, description: "…" }`);
      }
      if (s.description !== undefined && typeof s.description !== "string") {
        return fail(`seat "${s.name}": "description" must be text`);
      }
      seatNames!.push(s.name);
      seatDescriptions!.push(typeof s.description === "string" ? s.description : "");
    });
    seatCount = seatNames.length;
  } else {
    seatCount = typeof doc.seats === "number" ? doc.seats : fail(`"seats" must be a number of players (e.g. 4) or a list of named players`);
    if (!Number.isInteger(seatCount) || seatCount < 1) return fail(`"seats" must be a whole number of at least 1`);
  }

  const teams: TeamDef[] = [];
  if (doc.teams !== undefined) {
    if (!Array.isArray(doc.teams)) return fail(`"teams" must be a list of { name, seats } entries`);
    doc.teams.forEach((t, i) => {
      if (!isRecord(t) || typeof t.name !== "string" || !Array.isArray(t.seats)) {
        return fail(`team ${i + 1} needs a "name" and a "seats" list, e.g. { name: Reds, seats: [1, 2] }`);
      }
      const seats = t.seats.map((s) => {
        if (typeof s !== "number" || s < 1 || s > seatCount) return fail(`team "${t.name}": seat ${s} is out of range`);
        return s - 1;
      });
      teams.push({ name: t.name, seats });
    });
  }

  // Rounds: a fixed number, or a knob shown at setup.
  let fixedRounds: number | null = null;
  let roundsOption: GameOption | null = null;
  if (typeof doc.rounds === "number") {
    if (!Number.isInteger(doc.rounds) || doc.rounds < 1) return fail(`"rounds" must be a whole number of at least 1`);
    fixedRounds = doc.rounds;
  } else if (doc.rounds === undefined || isRecord(doc.rounds)) {
    const r = (doc.rounds ?? {}) as Record<string, unknown>;
    const int = (key: string, dflt: number): number => {
      if (r[key] === undefined) return dflt;
      if (typeof r[key] !== "number" || !Number.isInteger(r[key])) return fail(`"rounds.${key}" must be a whole number`);
      return r[key] as number;
    };
    const min = int("min", 1);
    const max = int("max", 50);
    const dflt = int("default", Math.min(Math.max(10, min), max));
    if (!(min <= dflt && dflt <= max)) return fail(`"rounds" needs min <= default <= max`);
    const label = typeof r.label === "string" ? r.label : "Rounds";
    roundsOption = { kind: "number", key: "rounds", label, min, max, default: dflt };
  } else {
    return fail(`"rounds" must be a number or { default, min, max }`);
  }

  // The vocabulary the formula tokenizer needs (multi-word names).
  const vocabNames = new Set<string>(Object.keys(constants));
  const collect = (v: unknown): void => {
    if (isRecord(v)) for (const k of Object.keys(v)) vocabNames.add(k);
  };
  collect(doc.state);
  collect(doc.derive);
  if (Array.isArray(doc.phases)) {
    for (const p of doc.phases) {
      if (isRecord(p) && Array.isArray(p.choices)) {
        for (const c of p.choices) {
          if (isRecord(c)) for (const [k, val] of Object.entries(c)) if (typeof val === "number") vocabNames.add(k);
        }
      }
    }
  }
  const vocab = [...vocabNames];
  const expr = (src: string, where: string): Expr => {
    try {
      return parseExpr(src, vocab);
    } catch (err) {
      return fail(`${where}: the formula "${src}" does not work (${err instanceof Error ? err.message : err})`);
    }
  };

  // State variables.
  const globals: VarDef[] = [];
  const perSeat: VarDef[] = [];
  if (doc.state !== undefined) {
    if (!isRecord(doc.state)) return fail(`"state" must be a set of \`name: initial value\` entries`);
    for (const [key, v] of Object.entries(doc.state)) {
      if (isRecord(v) && v["per seat"] !== undefined) {
        const ps = v["per seat"];
        if (Array.isArray(ps)) {
          // A list gives each seat its own starting value — asymmetric starts.
          if (ps.length !== seatCount) {
            return fail(`state.${key}: the "per seat" list needs one value per seat (${seatCount} seats, ${ps.length} values)`);
          }
          const inits = ps.map((e, i) => expr(String(e), `state.${key}, seat ${i + 1}`));
          perSeat.push({ name: key, init: inits[0], inits });
        } else {
          perSeat.push({ name: key, init: expr(String(ps), `state.${key}`) });
        }
      } else {
        globals.push({ name: key, init: expr(String(v), `state.${key}`) });
      }
    }
  }

  // Derived values.
  const derives: DeriveDef[] = [];
  if (doc.derive !== undefined) {
    if (!isRecord(doc.derive)) return fail(`"derive" must be a set of \`name: formula\` entries`);
    for (const [key, v] of Object.entries(doc.derive)) {
      if (isRecord(v) && v["per seat"] !== undefined) {
        derives.push({ name: key, scope: "seat", expr: expr(String(v["per seat"]), `derive.${key}`) });
      } else {
        derives.push({ name: key, scope: "global", expr: expr(String(isRecord(v) ? v.global : v), `derive.${key}`) });
      }
    }
  }

  // Phases.
  if (!Array.isArray(doc.phases) || doc.phases.length === 0) {
    return fail(`"phases" is required: the ordered list of steps that make up one round`);
  }
  const parseList = (raw: unknown, where: string): ListSpec => {
    if (!isRecord(raw) || typeof raw.each !== "string") {
      return fail(`${where}: "list" needs an "each" template`);
    }
    return {
      where: typeof raw.where === "string" ? raw.where : undefined,
      each: raw.each,
      join: typeof raw.join === "string" ? raw.join : ", ",
    };
  };

  const parseStmt = (raw: unknown, where: string, allowEach: boolean): Stmt => {
    if (typeof raw === "string") {
      const m = raw.match(/^\s*([A-Za-z_][\w ]*?)\s*(\+=|-=|=)\s*([\s\S]+)$/);
      if (!m) return fail(`${where}: "${raw}" is not an assignment (expected e.g. "price = …")`);
      return { kind: "assign", target: m[1].trim(), op: m[2] as "=" | "+=" | "-=", expr: expr(m[3], where) };
    }
    if (isRecord(raw)) {
      if ("each seat" in raw) {
        if (!allowEach) return fail(`${where}: "each seat" cannot nest`);
        if (!Array.isArray(raw["each seat"])) return fail(`${where}: "each seat" must be a list of statements`);
        return { kind: "each", body: raw["each seat"].map((s, i) => parseStmt(s, `${where} > each seat ${i + 1}`, false)) };
      }
      if ("say" in raw) {
        const when: WhenClause = [];
        if (raw.when !== undefined) {
          if (!isRecord(raw.when)) return fail(`${where}: "when" must look like { phase: choice }`);
          for (const [k, val] of Object.entries(raw.when)) {
            when.push([k, (Array.isArray(val) ? val : [val]).map(String)]);
          }
        }
        // A `say` may carry a `list` to fold a per-seat line into one grouped
        // {list}, exactly as an `observation` line does.
        const list = raw.list !== undefined ? parseList(raw.list, where) : undefined;
        return { kind: "say", when, template: String(raw.say), list };
      }
      // A `when/do` block: statements that run only for seats whose pick this
      // round matches, e.g. `when: { quarter: ship } do: [ "cash += …" ]`.
      // Pick-gating needs a seat, so these live inside an `each seat`.
      if ("when" in raw && "do" in raw) {
        if (allowEach) return fail(`${where}: a "when/do" block must sit inside an "each seat"`);
        if (!isRecord(raw.when)) return fail(`${where}: "when" must look like { phase: choice } (one or more choices)`);
        if (!Array.isArray(raw.do)) return fail(`${where}: "do" must be a list of statements`);
        const when: WhenClause = [];
        for (const [k, val] of Object.entries(raw.when)) {
          when.push([k, (Array.isArray(val) ? val : [val]).map(String)]);
        }
        return { kind: "when", when, body: raw.do.map((s, i) => parseStmt(s, `${where} > do ${i + 1}`, false)) };
      }
    }
    return fail(`${where}: a resolve step must be an assignment, a { say } line, a { when/do } block, or an { each seat } block`);
  };

  // Parse a choice list into ChoiceDef[], returning the ids for bot validation.
  const parseChoices = (rawChoices: unknown, where: string): { choices: ChoiceDef[]; ids: Set<string> } => {
    if (!Array.isArray(rawChoices) || rawChoices.length === 0) return fail(`${where}: "choices" is required`);
    const ids = new Set<string>();
    const choices = rawChoices.map((c, j): ChoiceDef => {
      const cwhere = `${where}, choice ${j + 1}`;
      if (!isRecord(c) || typeof c.label !== "string") return fail(`${cwhere}: every choice needs a "label"`);
      const cid = typeof c.id === "string" && c.id.trim() ? c.id.trim() : slug(c.label);
      if (ids.has(cid)) return fail(`${cwhere}: duplicate choice id "${cid}"`);
      ids.add(cid);
      if (c["disabled when"] !== undefined && typeof c["disabled when"] !== "string") {
        return fail(`${cwhere}: "disabled when" must be a condition, e.g. "capability < frontier"`);
      }
      if (c["disabled note"] !== undefined && typeof c["disabled note"] !== "string") {
        return fail(`${cwhere}: "disabled note" must be text — the reason shown when the option is greyed out`);
      }
      const nums: Record<string, number> = {};
      const texts: Record<string, string> = {};
      for (const [k, val] of Object.entries(c)) {
        if (k === "id" || k === "label" || k === "note" || k === "disabled when" || k === "disabled note") continue;
        if (typeof val === "number") nums[k] = val;
        else if (typeof val === "string") texts[k] = val;
      }
      return {
        id: cid,
        label: c.label,
        note: typeof c.note === "string" ? c.note : undefined,
        disabledWhen: typeof c["disabled when"] === "string" ? (c["disabled when"] as string) : undefined,
        disabledNote: typeof c["disabled note"] === "string" ? (c["disabled note"] as string) : undefined,
        nums,
        texts,
      };
    });
    return { choices, ids };
  };

  // The rule-based strategy: `bot:` is a priority list of { when, pick, say }
  // rules — the first whose conditions all hold plays.
  const parseBot = (rawBot: unknown, ids: Set<string>, where: string): BotRuleDef[] => {
    if (rawBot === undefined) return [];
    if (!Array.isArray(rawBot) || rawBot.length === 0) {
      return fail(`${where}: "bot" must be a list of { when, pick, say } rules`);
    }
    const bot: BotRuleDef[] = [];
    rawBot.forEach((r, j) => {
      const bwhere = `${where}, bot rule ${j + 1}`;
      if (!isRecord(r) || typeof r.pick !== "string") {
        return fail(`${bwhere}: every bot rule needs a "pick" naming one of the choice ids`);
      }
      if (!ids.has(r.pick)) return fail(`${bwhere}: "${r.pick}" is not a choice id here`);
      const whenRaw = r.when === undefined ? [] : Array.isArray(r.when) ? r.when : [r.when];
      const when = whenRaw.map((c) => {
        if (typeof c !== "string" || !c.trim()) return fail(`${bwhere}: "when" must be a condition (or a list of conditions that must all hold)`);
        return c;
      });
      if (r.say !== undefined && typeof r.say !== "string") return fail(`${bwhere}: "say" must be text`);
      bot.push({ when, pick: r.pick, say: typeof r.say === "string" ? r.say : undefined });
    });
    if (bot[bot.length - 1].when.length > 0) {
      return fail(`${where}: the last bot rule must have no "when" — the bot always needs a move`);
    }
    return bot;
  };

  // Phases compile to a flat list of internal phases (one per axis) plus a
  // `batches` grouping: a plain phase is a batch of one; a phase authored with
  // `axes` is a batch of several decided together. The group's `resolve` and
  // `none said` ride on the batch's last axis, so they run once, after every
  // axis in the batch has been recorded.
  const phases: PhaseDef[] = [];
  const batches: number[][] = [];
  const phaseKeys = new Set<string>();
  doc.phases.forEach((raw, i) => {
    const where = `phase ${i + 1}`;
    if (!isRecord(raw)) return fail(`${where} must be a set of \`key: value\` entries`);
    const groupKey = typeof raw.phase === "string" ? raw.phase.trim() : fail(`${where}: "phase" must name the step, e.g. move`);
    if (raw.by !== undefined && raw.by !== "everyone") return fail(`${where} ("${groupKey}"): only "by: everyone" is supported`);
    const resolve = Array.isArray(raw.resolve)
      ? raw.resolve.map((s, j) => parseStmt(s, `${where} ("${groupKey}") resolve ${j + 1}`, true))
      : [];
    const noneSaid = typeof raw["none said"] === "string" ? (raw["none said"] as string) : undefined;
    const commit = typeof raw.commit === "string" ? (raw.commit as string) : undefined;

    // Gather this phase's axes: either an explicit `axes` list, or the phase
    // itself as a single implicit axis keyed by the phase name.
    const units: { key: string; ask: string; choices: ChoiceDef[]; bot: BotRuleDef[] }[] = [];
    if (raw.axes !== undefined) {
      if (raw.choices !== undefined) return fail(`${where} ("${groupKey}"): a phase has either "choices" or "axes", not both`);
      if (!Array.isArray(raw.axes) || raw.axes.length === 0) {
        return fail(`${where} ("${groupKey}"): "axes" must be a non-empty list of { axis, ask, choices } decided together`);
      }
      raw.axes.forEach((a, k) => {
        const awhere = `${where} ("${groupKey}"), axis ${k + 1}`;
        if (!isRecord(a)) return fail(`${awhere} must be a set of \`key: value\` entries`);
        const axisKey = typeof a.axis === "string" && a.axis.trim() ? a.axis.trim() : fail(`${awhere}: "axis" must name the axis, e.g. lab`);
        if (a.by !== undefined && a.by !== "everyone") return fail(`${awhere} ("${axisKey}"): only "by: everyone" is supported`);
        if (typeof a.ask !== "string") return fail(`${awhere} ("${axisKey}"): "ask" is required — the question put to each seat`);
        const { choices, ids } = parseChoices(a.choices, `${awhere} ("${axisKey}")`);
        units.push({ key: axisKey, ask: a.ask, choices, bot: parseBot(a.bot, ids, `${awhere} ("${axisKey}")`) });
      });
    } else {
      if (typeof raw.ask !== "string") return fail(`${where} ("${groupKey}"): "ask" is required — the question put to each seat`);
      const { choices, ids } = parseChoices(raw.choices, `${where} ("${groupKey}")`);
      units.push({ key: groupKey, ask: raw.ask, choices, bot: parseBot(raw.bot, ids, `${where} ("${groupKey}")`) });
    }

    const batch: number[] = [];
    units.forEach((u, k) => {
      if (phaseKeys.has(u.key)) return fail(`${where} ("${groupKey}"): duplicate phase/axis name "${u.key}" — each must be unique`);
      phaseKeys.add(u.key);
      batch.push(phases.length);
      phases.push({
        key: u.key,
        ask: u.ask,
        choices: u.choices,
        // The group's resolve/none-said ride on the batch's last axis.
        noneSaid: k === units.length - 1 ? noneSaid : undefined,
        resolve: k === units.length - 1 ? resolve : [],
        bot: u.bot,
        commit,
      });
    });
    batches.push(batch);
  });

  // A rule-based seat must have a move at every axis: `bot:` is all-or-nothing.
  const botPhases = phases.filter((p) => p.bot.length > 0);
  if (botPhases.length > 0 && botPhases.length < phases.length) {
    const missing = phases.filter((p) => p.bot.length === 0).map((p) => `"${p.key}"`);
    return fail(`"bot" rules must cover every phase/axis or none — missing on ${missing.join(", ")}`);
  }

  // An authored early end: the game is over as soon as this condition holds
  // (checked between phases, over shared values — e.g. "doom > 0").
  if (doc["end when"] !== undefined && typeof doc["end when"] !== "string") {
    return fail(`"end when" must be a condition over shared values, e.g. "doom > 0"`);
  }
  const endWhen = typeof doc["end when"] === "string" ? (doc["end when"] as string) : null;

  // `at end` — a resolve block run exactly once when the match has just ended
  // (the horizon, the last round, or `end when`), before the outcome: final
  // settlements, reveals, and closing narration.
  let atEnd: Stmt[] = [];
  if (doc["at end"] !== undefined) {
    if (!Array.isArray(doc["at end"])) return fail(`"at end" must be a list of resolve steps`);
    atEnd = doc["at end"].map((s, i) => parseStmt(s, `at end, step ${i + 1}`, true));
  }

  // Outcome, rules, observation, view.
  const outcome = isRecord(doc.outcome) ? doc.outcome : {};
  const scoreVar = typeof outcome.score === "string" ? outcome.score : perSeat[0]?.name ?? "";
  const scorePerTeam = outcome.per !== undefined ? outcome.per === "team" : teams.length > 0;
  const winHighest = outcome.win !== "lowest";
  // `verdict` and `draw` are each one template, or a list of { when, text }
  // tried in order — the first whose `when` holds (or that has none) speaks.
  const verdictList = (value: unknown, key: string, dflt: string): VerdictDef[] => {
    if (!Array.isArray(value)) {
      return [{ text: typeof value === "string" ? value : dflt }];
    }
    return value.map((v, i) => {
      if (!isRecord(v) || typeof v.text !== "string") {
        return fail(`outcome.${key} entry ${i + 1} needs a "text" (and optionally a "when" condition)`);
      }
      return { when: typeof v.when === "string" ? v.when : undefined, text: v.text };
    });
  };
  const verdicts = verdictList(outcome.verdict, "verdict", "{winning team} wins.");
  const draws = verdictList(outcome.draw, "draw", "It's a tie.");

  const rules = typeof doc.rules === "string" ? doc.rules : fail(`"rules" is required — the standing rules told to each seat`);

  const observation: ObsLine[] = [];
  if (doc.observation !== undefined) {
    if (!Array.isArray(doc.observation)) return fail(`"observation" must be a list of lines`);
    doc.observation.forEach((raw, i) => {
      if (!isRecord(raw) || typeof raw.line !== "string") return fail(`observation line ${i + 1} needs a "line"`);
      const list = raw.list !== undefined ? parseList(raw.list, `observation line ${i + 1}`) : undefined;
      observation.push({ when: typeof raw.when === "string" ? raw.when : undefined, template: raw.line, list });
    });
  }

  const viewDoc = isRecord(doc.view) ? doc.view : {};
  const tableDoc = isRecord(viewDoc.table) ? viewDoc.table : {};
  const headlineDoc = isRecord(viewDoc.headline) ? viewDoc.headline : null;
  if (headlineDoc && (typeof headlineDoc.label !== "string" || typeof headlineDoc.value !== "string")) {
    return fail(`"view.headline" needs a "label" and a "value", e.g. { label: Unit price, value: "{price}" }`);
  }
  if (headlineDoc && headlineDoc.tip !== undefined && typeof headlineDoc.tip !== "string") {
    return fail(`"view.headline": "tip" must be text (shown on hover)`);
  }
  const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

  // `view.seats` — per-seat stat columns for the on-screen scoreboard. A
  // `secret: true` stat is masked on rows other than the watching players'
  // own: those rows render the `masked` template instead ("?" if none is
  // given), so a stat can degrade to its public part (e.g. a lab's last
  // released capability) rather than vanish.
  const seatStats: Model["view"]["seatStats"] = [];
  if (viewDoc.seats !== undefined) {
    if (!Array.isArray(viewDoc.seats)) return fail(`"view.seats" must be a list of { label, value } stat columns`);
    viewDoc.seats.forEach((raw, i) => {
      if (!isRecord(raw) || typeof raw.label !== "string" || typeof raw.value !== "string") {
        return fail(`"view.seats" entry ${i + 1} needs a "label" and a "value" template, e.g. { label: Cash, value: "{cash}" }`);
      }
      if (raw.masked !== undefined && typeof raw.masked !== "string") {
        return fail(`"view.seats" entry ${i + 1}: "masked" must be a template shown in place of a secret value`);
      }
      if (raw.masked !== undefined && raw.secret !== true) {
        return fail(`"view.seats" entry ${i + 1}: "masked" only makes sense on a secret stat`);
      }
      let map: string[] | undefined;
      if (raw.map !== undefined) {
        if (!Array.isArray(raw.map)) return fail(`"view.seats" entry ${i + 1}: "map" must be a list of labels indexed by the value`);
        map = raw.map.map(String);
      }
      if (raw.tip !== undefined && typeof raw.tip !== "string") {
        return fail(`"view.seats" entry ${i + 1}: "tip" must be text (shown on hover over the column header)`);
      }
      seatStats.push({
        label: raw.label,
        value: raw.value,
        secret: raw.secret === true,
        masked: raw.masked as string | undefined,
        map,
        tip: raw.tip as string | undefined,
      });
    });
  }

  const view = {
    status: typeof viewDoc.status === "string" ? viewDoc.status : "round {round}",
    turnTag: typeof viewDoc["turn tag"] === "string" ? (viewDoc["turn tag"] as string) : "R{round}",
    headlineLabel: headlineDoc ? (headlineDoc.label as string) : undefined,
    headlineValue: headlineDoc ? (headlineDoc.value as string) : undefined,
    headlineTip: headlineDoc ? (headlineDoc.tip as string | undefined) : undefined,
    tableColumns: strList(tableDoc.columns),
    tableCells: strList(tableDoc.cells),
    seatStats,
  };

  const endWindow = constants["end window"] ?? 0;
  const model: Model = {
    id,
    name,
    blurb: "",
    seatCount,
    seatNames,
    seatDescriptions,
    teams,
    constants,
    endWindow,
    fixedRounds,
    roundsOption,
    globals,
    perSeat,
    derives,
    phases,
    batches,
    scoreVar,
    scorePerTeam,
    winHighest,
    verdicts,
    draws,
    endWhen,
    atEnd,
    rules,
    observation,
    view,
    vocab,
  };
  const blurbSrc = typeof doc.description === "string" ? doc.description.trim() : "";
  if (blurbSrc) model.blurb = render(blurbSrc, makeEnv(model, emptyView(), { round: 0, picks: {} }));
  return model;
}

function emptyView(): View {
  return { names: [], globals: {}, perSeat: [], history: [], roundsMax: 0 };
}

// ---------------------------------------------------------------------------
// Compile a Model into a runnable GameSpec.

export function compileGame(doc: unknown): GameSpec<GameFileState> {
  const model = normalize(doc);
  const seats = range(model.seatCount);
  const lastPhase = model.phases[model.phases.length - 1];
  const roleNames = model.teams.length
    ? seats.map((s) => model.teams[model.teams.findIndex((t) => t.seats.includes(s))]?.name)
    : undefined;

  const viewOf = (state: GameFileState): View => ({
    names: state.names,
    globals: state.globals,
    perSeat: state.perSeat,
    history: state.history,
    roundsMax: state.roundsMax,
  });
  const round = (state: GameFileState): number =>
    state.history.length >= state.endsAt ? state.history.length : state.history.length + 1;
  const currentPhase = (state: GameFileState): PhaseDef =>
    model.phases.find((p) => !(`${p.key}:0` in state.picks)) ?? model.phases[0];
  // The batch (one or more axes) awaiting picks: the first batch that still has
  // an unpicked axis. A whole batch is gathered and resolved by one `apply`.
  const currentBatch = (state: GameFileState): PhaseDef[] => {
    const idxs =
      model.batches.find((b) => b.some((i) => !(`${model.phases[i].key}:0` in state.picks))) ?? model.batches[0];
    return idxs.map((i) => model.phases[i]);
  };
  const teamTotals = (perSeat: SeatVars[]): number[] =>
    model.teams.map((t) => t.seats.reduce((s, m) => s + perSeat[m][model.scoreVar], 0));

  const init: GameSpec<GameFileState>["init"] = ({ seatNames, options }) => {
    const roundsMax = model.roundsOption ? Number(options[model.roundsOption.key]) : model.fixedRounds!;
    const window = Math.min(model.endWindow, roundsMax);
    const endsAt = roundsMax - Math.floor(Math.random() * window);
    const base: View = { ...emptyView(), roundsMax };
    const globalsEnv = makeEnv(model, base, { round: 1, picks: {} });
    // Initial values land on the same 1dp grid the resolve assignments keep.
    const grid = (n: number): number => Math.round(n * 10) / 10;
    const globals: Record<string, number> = {};
    for (const g of model.globals) globals[g.name] = grid(evalExpr(g.init, globalsEnv));
    const perSeat = seatNames.map((_, seat) => {
      const o: SeatVars = {};
      for (const v of model.perSeat) o[v.name] = grid(evalExpr(v.inits ? v.inits[seat] : v.init, globalsEnv));
      return o;
    });
    return { names: [...seatNames], roundsMax, endsAt, globals, perSeat, picks: {}, history: [] };
  };

  const decisions: GameSpec<GameFileState>["decisions"] = (state) => {
    if (state.history.length >= state.endsAt) return [];
    if (model.endWhen && truthy(model.endWhen, makeEnv(model, viewOf(state), { round: round(state), picks: state.picks }))) {
      return [];
    }
    const batch = currentBatch(state);
    const r = round(state);
    const out: Decision[] = [];
    // One decision per axis per seat; the whole batch is gathered before any
    // resolution, so a seat picks all its axes for the round at once.
    for (const phase of batch) {
      for (const seat of seats) {
        const env = makeEnv(model, viewOf(state), { seat, round: r, picks: state.picks, phase: phase.key });
        const choices: Choice[] = phase.choices.map((c) => {
          // An option gone unavailable this turn: greyed for humans (with its
          // `disabled note` as the tooltip), hidden from agents by the engine.
          const disabled = c.disabledWhen ? truthy(c.disabledWhen, env) : false;
          const reason = disabled ? c.disabledNote : c.note;
          return {
            id: c.id,
            label: c.label,
            detail: reason ? render(reason, env) : undefined,
            ...(disabled ? { disabled: true } : {}),
          };
        });
        out.push({ seat, key: `${phase.key}:${seat}`, prompt: render(phase.ask, env), choices, commitLabel: phase.commit });
      }
    }
    return out;
  };

  const apply: GameSpec<GameFileState>["apply"] = (state, picks): StepResult<GameFileState> => {
    const batch = currentBatch(state);
    const r = round(state);
    const newPicks = { ...state.picks };
    for (const phase of batch) for (const seat of seats) newPicks[`${phase.key}:${seat}`] = picks[`${phase.key}:${seat}`];
    const events: string[] = [];

    // The resolve block: run statements top-to-bottom over a working copy.
    // `phaseKey` names the axis a statement resolves under (for `tally`,
    // `{choice}`); a group's resolve runs under its last axis's key.
    const working = { globals: { ...state.globals }, perSeat: state.perSeat.map((o) => ({ ...o })) };
    const workView = (): View => ({ ...viewOf(state), globals: working.globals, perSeat: working.perSeat });
    const runStmt = (stmt: Stmt, phaseKey: string, seat?: number): void => {
      if (stmt.kind === "each") {
        for (const s of seats) for (const inner of stmt.body) runStmt(inner, phaseKey, s);
        return;
      }
      if (stmt.kind === "when") {
        // Runs its body only for seats whose pick this round matches.
        const holds = stmt.when.every(([ph, ids]) => ids.includes(newPicks[`${ph}:${seat}`]));
        if (holds) for (const inner of stmt.body) runStmt(inner, phaseKey, seat);
        return;
      }
      const env = makeEnv(model, workView(), { seat, round: r, picks: newPicks, phase: phaseKey, resolving: true });
      if (stmt.kind === "assign") {
        const val = evalExpr(stmt.expr, env);
        const bag = model.globals.some((g) => g.name === stmt.target)
          ? working.globals
          : (working.perSeat[seat!] as Record<string, number>);
        const cur = bag[stmt.target] ?? 0;
        const next = stmt.op === "+=" ? cur + val : stmt.op === "-=" ? cur - val : val;
        // State lives on a 1dp grid: round every write so binary float dust
        // can never accumulate into the economy or leak into comparisons.
        bag[stmt.target] = Math.round(next * 10) / 10;
      } else {
        const holds = stmt.when.every(([ph, ids]) => ids.includes(newPicks[`${ph}:${seat}`]));
        if (!holds) return;
        // A `say` with a `list` folds a per-seat line into one grouped {list},
        // rendering `each` over every seat (optionally filtered by `where`).
        let listString: string | undefined;
        if (stmt.list) {
          const items: string[] = [];
          for (const k of seats) {
            const kenv = makeEnv(model, workView(), { seat: k, round: r, picks: newPicks, phase: phaseKey, resolving: true });
            if (stmt.list.where && !truthy(stmt.list.where, kenv)) continue;
            items.push(render(stmt.list.each, kenv));
          }
          listString = items.join(stmt.list.join);
          if (!listString) return; // an empty list drops the whole line
        }
        const sayEnv =
          listString === undefined
            ? env
            : makeEnv(model, workView(), { seat, round: r, picks: newPicks, phase: phaseKey, resolving: true, listString });
        const line = render(stmt.template, sayEnv);
        if (line.trim()) events.push(line);
      }
    };

    // Resolve each axis of the batch in order: its choices' auto-`say` lines,
    // then its resolve block (only the batch's last axis carries the group's).
    for (const phase of batch) {
      let anySaid = false;
      for (const seat of seats) {
        const c = phase.choices.find((x) => x.id === newPicks[`${phase.key}:${seat}`]);
        const say = c?.texts.say;
        if (say) {
          const line = render(say, makeEnv(model, viewOf(state), { seat, round: r, picks: newPicks, phase: phase.key }));
          if (line.trim()) {
            events.push(line);
            anySaid = true;
          }
        }
      }
      if (!anySaid && phase.noneSaid) {
        const line = render(phase.noneSaid, makeEnv(model, viewOf(state), { round: r, picks: newPicks, phase: phase.key }));
        if (line.trim()) events.push(line);
      }
      for (const stmt of phase.resolve) runStmt(stmt, phase.key);
    }

    const isLast = batch.includes(lastPhase);
    const resolveKey = batch[batch.length - 1].key;

    // `at end`: if the match is over as of this resolution (the horizon or an
    // `end when`), run the one-off settlement block over the same working
    // state before it is banked, so the final round row records the settled
    // values and the outcome reads them.
    if (model.atEnd.length) {
      const endedByHorizon = isLast && state.history.length + 1 >= state.endsAt;
      const endedByCondition =
        model.endWhen !== null &&
        truthy(model.endWhen, makeEnv(model, workView(), { round: r, picks: newPicks, phase: resolveKey }));
      if (endedByHorizon || endedByCondition) {
        for (const stmt of model.atEnd) runStmt(stmt, resolveKey);
      }
    }

    const next: GameFileState = isLast
      ? {
          ...state,
          globals: working.globals,
          perSeat: working.perSeat,
          picks: {},
          history: [
            ...state.history,
            { picks: newPicks, globals: { ...working.globals }, perSeat: working.perSeat.map((o) => ({ ...o })) },
          ],
        }
      : { ...state, globals: working.globals, perSeat: working.perSeat, picks: newPicks };
    return { state: next, events };
  };

  // The verdict/draw template whose `when` holds right now (or the unconditional one).
  const chooseText = (list: VerdictDef[], state: GameFileState, r: number): string => {
    const env = makeEnv(model, viewOf(state), { round: r, picks: state.picks });
    return list.find((v) => !v.when || truthy(v.when, env))?.text ?? "";
  };

  const outcome: GameSpec<GameFileState>["outcome"] = (state): Outcome => {
    const r = round(state);
    if (model.scorePerTeam && model.teams.length === 2) {
      const [a, b] = teamTotals(state.perSeat);
      if (a === b) {
        const env = makeEnv(model, viewOf(state), { round: r, extraTexts: { cash: String(a) } });
        return { summary: render(chooseText(model.draws, state, r), env), winners: [] };
      }
      const win = (model.winHighest ? a > b : a < b) ? 0 : 1;
      const totals: [number, number] = [a, b];
      const env = makeEnv(model, viewOf(state), {
        round: r,
        extraTexts: {
          "winning team": model.teams[win].name,
          "losing team": model.teams[1 - win].name,
          "winning cash": String(totals[win]),
          "losing cash": String(totals[1 - win]),
        },
      });
      return { summary: render(chooseText(model.verdicts, state, r), env), winners: model.teams[win].seats };
    }
    // Per-seat fallback. A sole winner's verdict is rendered from their seat,
    // so `{player}` (and any per-seat value) speaks of the winner.
    const scores = state.perSeat.map((o) => o[model.scoreVar]);
    const best = model.winHighest ? Math.max(...scores) : Math.min(...scores);
    const winners = seats.filter((s) => scores[s] === best);
    const env = makeEnv(model, viewOf(state), {
      round: r,
      seat: winners.length === 1 ? winners[0] : undefined,
      extraTexts: { cash: String(best) },
    });
    return {
      summary: render(chooseText(winners.length === 1 ? model.verdicts : model.draws, state, r), env),
      winners: winners.length === seats.length ? [] : winners,
    };
  };

  const rules: GameSpec<GameFileState>["rules"] = (state, seat) =>
    render(model.rules, makeEnv(model, viewOf(state), { seat, round: round(state), picks: state.picks }));

  const observation: GameSpec<GameFileState>["observation"] = (state, seat) => {
    const r = round(state);
    const phase = currentPhase(state);
    const view = viewOf(state);
    const lines: string[] = [];
    for (const line of model.observation) {
      let listString: string | undefined;
      if (line.list) {
        const items: string[] = [];
        for (const k of seats) {
          const kenv = makeEnv(model, view, { seat: k, round: r, picks: state.picks, phase: phase.key });
          if (line.list.where && !truthy(line.list.where, kenv)) continue;
          items.push(render(line.list.each, kenv));
        }
        listString = items.join(line.list.join);
        // A line whose list came out empty (e.g. nobody spoke) is dropped.
        if (!listString) continue;
      }
      if (line.when && !condHolds(line.when, model, view, seat, r, phase.key, state.picks)) continue;
      const env = makeEnv(model, view, { seat, round: r, picks: state.picks, phase: phase.key, listString });
      lines.push(render(line.template, env));
    }
    return lines.filter((l) => l.trim()).join("\n");
  };

  // The authored per-phase `bot:` strategy, if any: the first rule whose
  // conditions all hold plays, its `say` rendered from the deciding seat as
  // the logged reasoning. The last rule of a phase is unconditional (the
  // parser enforces it), so a pick always comes out.
  const bot: GameSpec<GameFileState>["bot"] = model.phases.some((p) => p.bot.length > 0)
    ? (state, decision): BotPick | null => {
        // A batch may hold several axes at once; find the one this decision is for.
        const phase = currentBatch(state).find((p) => decision.key === `${p.key}:${decision.seat}`);
        if (!phase) return null;
        const view = viewOf(state);
        const r = round(state);
        for (const rule of phase.bot) {
          if (!rule.when.every((c) => condHolds(c, model, view, decision.seat, r, phase.key, state.picks))) continue;
          const env = makeEnv(model, view, { seat: decision.seat, round: r, picks: state.picks, phase: phase.key });
          return { choiceId: rule.pick, reasoning: rule.say ? render(rule.say, env) : "" };
        }
        return null;
      }
    : undefined;

  return {
    id: model.id,
    name: model.name,
    blurb: model.blurb,
    seats: {
      min: model.seatCount,
      max: model.seatCount,
      roleNames,
      names: model.seatNames ?? undefined,
      descriptions: model.seatDescriptions ?? undefined,
    },
    options: model.roundsOption ? [{ ...model.roundsOption }] : undefined,
    init,
    decisions,
    apply,
    outcome,
    bot,
    rules,
    observation,
    view: {
      status: (state) =>
        render(model.view.status, makeEnv(model, viewOf(state), { round: round(state), picks: state.picks })),
      headline: model.view.headlineValue
        ? (state) => {
            const env = makeEnv(model, viewOf(state), { round: round(state), picks: state.picks });
            return {
              label: render(model.view.headlineLabel ?? "", env),
              value: render(model.view.headlineValue!, env),
              tip: model.view.headlineTip,
            };
          }
        : undefined,
      scores: (state) => state.perSeat.map((o) => o[model.scoreVar]),
      seatStats: model.view.seatStats.length
        ? (state, reveal = []) => {
            const columns = model.view.seatStats.map((s) => s.label);
            const tips = model.view.seatStats.map((s) => s.tip);
            const rows = seats.map((seat) => {
              const env = makeEnv(model, viewOf(state), { seat, round: round(state), picks: state.picks });
              return model.view.seatStats.map((s): string | number => {
                // A secret stat shows its true value only on `reveal`ed rows
                // (the players watching this screen); every other row renders
                // the authored `masked` template — "?" when none is given.
                const hidden = s.secret && !reveal.includes(seat);
                if (hidden && s.masked === undefined) return "?";
                const out = render(hidden ? s.masked! : s.value, env);
                if (s.map && /^-?\d+$/.test(out)) {
                  // In range the map supplies the label; out of range the
                  // number stands as-is, so a map can caption a few special
                  // values (e.g. 0 → "?") without swallowing the rest.
                  const n = Number(out);
                  return n >= 0 && n < s.map.length ? s.map[n] : n;
                }
                return /^-?\d+$/.test(out) ? Number(out) : out;
              });
            });
            return { columns, tips, rows };
          }
        : undefined,
      turnTag: (state) =>
        render(model.view.turnTag, makeEnv(model, viewOf(state), { round: round(state), picks: state.picks })),
      table: (state) => {
        if (!state.history.length) return null;
        const headerEnv = makeEnv(model, viewOf(state), { round: 0, picks: {} });
        const columns = ["#", ...state.names, ...model.view.tableColumns.map((c) => render(c, headerEnv))];
        // A seat's cell shows every axis decided in the final batch (e.g. the
        // lab move AND the public posture), joined — not just the last axis.
        const lastBatch = model.batches[model.batches.length - 1].map((idx) => model.phases[idx]);
        const rows = state.history.map((rrow, i) => {
          const rv: View = { ...viewOf(state), globals: rrow.globals, perSeat: rrow.perSeat };
          const env = makeEnv(model, rv, { round: i + 1, picks: rrow.picks });
          const moves = seats.map((seat) =>
            lastBatch
              .map((ph) => ph.choices.find((c) => c.id === rrow.picks[`${ph.key}:${seat}`])?.label ?? "")
              .filter((label) => label !== "")
              .join(" / "),
          );
          // A cell that is a lone {…} resolving to a whole number is kept numeric.
          const cell = (tpl: string): string | number => {
            const out = render(tpl, env);
            return /^\{[^{}]+\}$/.test(tpl.trim()) && /^-?\d+$/.test(out) ? Number(out) : out;
          };
          return [i + 1, ...moves, ...model.view.tableCells.map(cell)];
        });
        return { columns, rows };
      },
    },
  };
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Parse a YAML (or JSON) game file and compile it into a runnable game.
 */
export function parseGame(text: string): GameSpec<GameFileState> {
  let doc: unknown;
  try {
    doc = parseYAML(text);
  } catch (err) {
    throw new Error(`Game file: not valid YAML — ${err instanceof Error ? err.message : err}`);
  }
  return compileGame(doc);
}
