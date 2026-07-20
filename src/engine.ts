/**
 * The match engine: drives one game (a `GameSpec`) from start to finish,
 * querying an `Agent` for every LLM-controlled decision and accepting supplied
 * picks for human-controlled ones. Framework-free — the React components sit
 * on top of it, and non-React hosts can use it directly.
 */

import type { Choice, Decision, GameSpec, OptionValues } from "./dsl.js";
import { defaultOptions } from "./dsl.js";
import { STR, fmt } from "./strings.js";

/** A line in the match transcript: agent reasoning, game narration, or an error. */
export interface TranscriptEntry {
  author: string;
  text: string;
  kind: "reasoning" | "info" | "error";
  /** Short turn label from the spec's `view.turnTag`, e.g. "R3". */
  tag?: string;
}

/** Everything an agent is shown for one decision. */
export interface AgentRequest {
  seat: number;
  seatName: string;
  /** The decision's `key`, so a stateful agent can find it in `spec.decisions(state)`. */
  key: string;
  /** The game's standing rules from this seat's perspective. */
  rules: string;
  /** What this seat can currently see (history, totals, pending offers, …). */
  observation: string;
  /** The question being asked right now. */
  prompt: string;
  choices: Choice[];
}

export interface AgentReply {
  /** The id of the chosen option. */
  choiceId: string;
  /** The agent's stated reasoning, logged to the transcript. */
  reasoning: string;
  /** True when the reply had to be salvaged (e.g. unparseable model output). */
  parseFailed: boolean;
}

/**
 * Anything that can decide: the built-in WebLLM agent, a remote API, a
 * scripted bot. Requests within one batch are independent and see only the
 * pre-resolution state, so agents cannot leak picks to each other.
 */
export interface Agent {
  choose(req: AgentRequest): Promise<AgentReply>;
}

/**
 * An `Agent` that plays by the game's own authored strategy (`spec.bot`, the
 * per-phase `bot:` rules of a game file) — no model involved. It needs the
 * live match state, supplied via `getState`, because `AgentRequest`
 * deliberately carries only the textual view; `spec.bot` is trusted to read
 * only what the deciding seat could fairly see. Falls back to a flagged
 * random choice if the game has no rule for the decision, so a match can
 * never get stuck.
 */
export function ruleAgent<S>(spec: GameSpec<S>, getState: () => S): Agent {
  return {
    async choose(req: AgentRequest): Promise<AgentReply> {
      const state = getState();
      const decision = spec.decisions(state).find((d) => d.key === req.key);
      const pick = decision ? spec.bot?.(state, decision) : null;
      if (pick && req.choices.some((c) => c.id === pick.choiceId)) {
        return { choiceId: pick.choiceId, reasoning: pick.reasoning, parseFailed: false };
      }
      return {
        choiceId: req.choices[Math.floor(Math.random() * req.choices.length)].id,
        reasoning: "(the game has no bot rule for this decision; a random choice was played instead)",
        parseFailed: true,
      };
    },
  };
}

export class Match<S> {
  readonly spec: GameSpec<S>;
  readonly seatNames: string[];
  state: S;

  constructor(spec: GameSpec<S>, seatNames: string[], options?: OptionValues) {
    const { min, max } = spec.seats;
    if (seatNames.length < min || seatNames.length > max) {
      throw new Error(`${spec.name} takes ${min === max ? min : `${min}–${max}`} seats, got ${seatNames.length}`);
    }
    this.spec = spec;
    this.seatNames = seatNames;
    this.state = spec.init({
      seatNames: [...seatNames],
      options: { ...defaultOptions(spec as GameSpec<unknown>), ...options },
    });
  }

  /** The batch of decisions currently awaiting picks (empty when the game is over). */
  get pending(): Decision[] {
    return this.spec.decisions(this.state);
  }

  get over(): boolean {
    return this.pending.length === 0;
  }

  outcome() {
    return this.spec.outcome(this.state);
  }

  /**
   * Resolve the current batch. Seats present in `agents` are asked to choose;
   * every other decision must be covered by `picks` (keyed by decision key).
   * Agents are queried sequentially against the pre-resolution state, so no
   * decision in the batch can see another. Returns the transcript entries the
   * step produced (agent reasoning, then the game's own narration).
   */
  async step(
    agents: Partial<Record<number, Agent>>,
    picks: Record<string, string> = {},
  ): Promise<TranscriptEntry[]> {
    const pending = this.pending;
    if (pending.length === 0) throw new Error("The match is already over");
    const tag = this.spec.view.turnTag?.(this.state);
    const entries: TranscriptEntry[] = [];
    const resolved: Record<string, string> = {};

    for (const d of pending) {
      // A disabled option is unavailable this turn: hide it from agents, reject
      // it as a human pick, and never substitute it. Fall back to the full list
      // only if a bug ever disabled everything, so a seat always has a move.
      const offered = d.choices.filter((c) => !c.disabled);
      const legalChoices = offered.length > 0 ? offered : d.choices;
      const randomLegal = () => legalChoices[Math.floor(Math.random() * legalChoices.length)].id;

      const agent = agents[d.seat];
      if (!agent) {
        const pick = picks[d.key];
        if (pick === undefined) {
          throw new Error(`No pick supplied for decision "${d.key}" (seat ${d.seat} has no agent)`);
        }
        if (!legalChoices.some((c) => c.id === pick)) {
          throw new Error(`"${pick}" is not a legal choice for decision "${d.key}"`);
        }
        resolved[d.key] = pick;
        continue;
      }
      let reply: AgentReply;
      try {
        reply = await agent.choose({
          seat: d.seat,
          seatName: this.seatNames[d.seat],
          key: d.key,
          rules: this.spec.rules(this.state, d.seat),
          observation: this.spec.observation(this.state, d.seat),
          prompt: d.prompt,
          choices: legalChoices,
        });
      } catch (err) {
        // Fail soft on a crashing agent (a lost GPU device, a dead backend):
        // one broken decision must not abort the whole match. Substitute a
        // random legal choice and put the cause in the transcript, so the
        // match plays on with the failure visible instead of dying mid-step.
        resolved[d.key] = randomLegal();
        entries.push({
          author: this.seatNames[d.seat],
          text: fmt(STR.engine.agentFailed, { error: err instanceof Error ? err.message : String(err) }),
          kind: "error",
          tag,
        });
        continue;
      }
      // Fail soft on a lawless agent so a match can never get stuck: substitute
      // a random legal choice and flag it in the transcript.
      const legal = legalChoices.some((c) => c.id === reply.choiceId);
      const choiceId = legal ? reply.choiceId : randomLegal();
      resolved[d.key] = choiceId;
      entries.push({
        author: this.seatNames[d.seat],
        text: legal ? reply.reasoning : fmt(STR.engine.agentIllegalChoice, { choice: reply.choiceId }),
        kind: legal && !reply.parseFailed ? "reasoning" : "error",
        tag,
      });
    }

    const result = this.spec.apply(this.state, resolved);
    this.state = result.state;
    for (const ev of result.events ?? []) {
      const { author = STR.engine.narrationAuthor, text } = typeof ev === "string" ? { text: ev } : ev;
      entries.push({ author, text, kind: "info", tag });
    }
    return entries;
  }
}
