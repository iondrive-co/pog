import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { GameSpec, OptionValues, Outcome } from "../dsl.js";
import type { SeatConfig } from "../config.js";
import { Match, ruleAgent, type Agent, type TranscriptEntry } from "../engine.js";
import { Transcript } from "./Transcript.js";

/** A snapshot of a running (or finished) match, handed to `onUpdate`. */
export interface MatchUpdate<S> {
  spec: GameSpec<S>;
  seats: SeatConfig[];
  scores: (number | string)[];
  transcript: TranscriptEntry[];
  /** True once the game is over; `outcome` is then set. */
  over: boolean;
  outcome: Outcome | null;
  /** Epoch ms when this match view mounted — stable across the match. */
  startedAt: number;
}

export interface MatchViewProps<S> {
  spec: GameSpec<S>;
  seats: SeatConfig[];
  options: OptionValues;
  /** Builds the Agent that plays an LLM seat (e.g. the built-in `webLLMAgent`). */
  agentFor: (seat: SeatConfig, index: number) => Agent;
  onExit: () => void;
  /**
   * Start auto-playing the instant the match mounts, with no manual step — set
   * by the spectate option, where every seat is a bot and no human is present,
   * so the game runs to completion untouched. Ignored when any seat is human.
   */
  autoStart?: boolean;
  /**
   * Called after every resolved step and once the game ends, with a snapshot of
   * the match. Hosts use it to persist or mirror the transcript (the demo writes
   * one timestamped file per match).
   */
  onUpdate?: (update: MatchUpdate<S>) => void;
}

/**
 * Runs one match of any DSL game: scoreboard, choice buttons for human seats
 * (picks stay hidden until the whole batch resolves), the outcome, the spec's
 * history table, and the live transcript. With a human in the match the bots'
 * turns play automatically after each human pick; all-LLM matches get manual
 * step / auto-play controls, or — when `autoStart` is set (spectating) — play
 * themselves through to the end with nothing to press.
 */
export function MatchView<S>(props: MatchViewProps<S>) {
  const { spec, seats, options, agentFor, onExit } = props;

  // The match and its agents live for the lifetime of this component; a
  // version counter re-renders after each (mutating) step.
  const matchRef = useRef<Match<S> | null>(null);
  if (!matchRef.current) {
    matchRef.current = new Match(spec, seats.map((s) => s.name), options);
  }
  const match = matchRef.current;
  const agents = useMemo(() => {
    const map: Partial<Record<number, Agent>> = {};
    seats.forEach((s, i) => {
      if (s.kind === "llm") map[i] = agentFor(s, i);
      // A rule-based seat plays the game's own authored strategy, reading the
      // live match state — no model involved.
      else if (s.kind === "rules") map[i] = ruleAgent(spec, () => matchRef.current!.state);
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fixed for the match's life
  }, []);
  const [version, bump] = useReducer((n: number) => n + 1, 0);

  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [staged, setStaged] = useState<Record<string, string>>({});
  // Radio selections for a seat deciding several axes at once, before it
  // commits them together with one button.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  // Set when an auto-advanced bot step failed, so we stop retrying the same
  // failing batch and surface a manual "continue" control instead.
  const [autoPaused, setAutoPaused] = useState(false);
  const autoRef = useRef(false);
  const startedAtRef = useRef(Date.now());

  const pending = match.pending;
  const over = pending.length === 0;
  const humanDecisions = pending.filter((d) => seats[d.seat].kind === "human");
  const nextHuman = humanDecisions.find((d) => staged[d.key] === undefined);
  const noHumans = seats.every((s) => s.kind !== "human");
  const hasHuman = !noHumans;
  const anyBotPending = pending.some((d) => seats[d.seat].kind !== "human");

  const logError = (err: unknown) =>
    setTranscript((t) => [
      ...t,
      {
        author: "System",
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        kind: "error",
      },
    ]);

  /** Resolve the current batch; throws on failure so callers control the loop. */
  async function runStep(picks: Record<string, string>): Promise<void> {
    const entries = await match.step(agents, picks);
    // Drop bare one-word reasoning (e.g. "sell") — the move it names is already
    // spelled out in the narration line that follows it.
    const visible = entries.filter(
      (e) => !(e.kind === "reasoning" && e.text.trim().split(/\s+/).length <= 1),
    );
    setTranscript((t) => [...t, ...visible]);
    bump();
  }

  async function resolve(picks: Record<string, string>) {
    setBusy(true);
    try {
      await runStep(picks);
    } catch (err) {
      logError(err);
      // Halt the auto-advance so we don't spin on the same failing batch.
      setAutoPaused(true);
    }
    setStaged({});
    setDraft({});
    setBusy(false);
  }

  // Record a seat's picks; once every human in the batch has picked, resolve it.
  const commit = (next: Record<string, string>) => {
    setStaged(next);
    if (humanDecisions.every((d) => next[d.key] !== undefined)) {
      setAutoPaused(false);
      void resolve(next);
    }
  };
  const stagePick = (key: string, choiceId: string) => commit({ ...staged, [key]: choiceId });
  // Commit a seat's radio selections (several axes) in one go.
  const commitSeat = (seatDecisions: typeof pending) => {
    const next = { ...staged };
    for (const d of seatDecisions) next[d.key] = draft[d.key];
    commit(next);
  };

  async function autoPlay() {
    setAuto(true);
    autoRef.current = true;
    setBusy(true);
    try {
      while (
        autoRef.current &&
        match.pending.length > 0 &&
        match.pending.every((d) => seats[d.seat].kind !== "human")
      ) {
        await runStep({});
      }
    } catch (err) {
      logError(err);
    }
    autoRef.current = false;
    setAuto(false);
    setBusy(false);
  }

  // Spectate: an all-LLM match asked to auto-start plays itself through to the
  // end the moment it mounts, so the viewer never has to press anything. Fires
  // once; if a bot step later fails, `autoPlay` stops and the manual controls
  // below appear so the run can be resumed.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!props.autoStart || autoStartedRef.current || over || !noHumans) return;
    autoStartedRef.current = true;
    void autoPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on mount
  }, [props.autoStart, noHumans, over]);

  // With a human in the match, take the bots' turns automatically: whenever the
  // pending batch needs no human input, resolve it — stopping only when it's a
  // human's turn again or the game is over. (All-LLM matches use the manual
  // controls below instead.)
  useEffect(() => {
    if (!hasHuman || busy || over || autoPaused) return;
    const batch = match.pending;
    if (batch.length > 0 && batch.every((d) => seats[d.seat].kind !== "human")) {
      void resolve({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version tracks state changes
  }, [version, busy, over, autoPaused, hasHuman]);

  // Report progress (and the final outcome) so a host can persist the match.
  useEffect(() => {
    if (transcript.length === 0 && !over) return;
    props.onUpdate?.({
      spec,
      seats,
      scores: spec.view.scores(match.state),
      transcript,
      over,
      outcome: over ? match.outcome() : null,
      startedAt: startedAtRef.current,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on transcript / game-over changes
  }, [transcript, over]);

  const scores = spec.view.scores(match.state);
  const headline = spec.view.headline?.(match.state) ?? null;
  // Human seats see their own secret stats in the table; bots' rows stay masked.
  const seatStats =
    spec.view.seatStats?.(
      match.state,
      seats.flatMap((s, i) => (s.kind === "human" ? [i] : [])),
    ) ?? null;
  const table = spec.view.table?.(match.state) ?? null;
  const botSeatNames = [...new Set(pending.map((d) => seats[d.seat].name))].join(", ");

  return (
    <div className="match-grid">
      <section className="card">
        <div className="card-title">
          <h2>
            {spec.name} — {spec.view.status(match.state)}
          </h2>
          <button
            onClick={() => {
              autoRef.current = false;
              onExit();
            }}
          >
            New match
          </button>
        </div>

        {headline && (
          <div className="headline" data-tip={headline.tip}>
            <span className="headline-label">{headline.label}</span>
            <span className="headline-value">{headline.value}</span>
          </div>
        )}

        {seatStats ? (
          /* Per-seat stats table (view.seats): one row per seat; secret stats
             arrive pre-masked, so the shared screen never leaks them. */
          <table className="history-table seat-stats">
            <thead>
              <tr>
                <th></th>
                {seatStats.columns.map((c, i) => (
                  <th key={i} data-tip={seatStats.tips?.[i]}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {seats.map((s, i) => (
                <tr key={i}>
                  <td className="score-name">
                    {s.name} {s.kind === "human" ? "🧑" : "🤖"}
                    {spec.seats.roleNames?.[i] ? ` (${spec.seats.roleNames[i]})` : ""}
                  </td>
                  {seatStats.rows[i].map((v, j) => (
                    <td key={j}>{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="scoreboard">
            {seats.map((s, i) => (
              <div key={i} className="score">
                <span className="score-name">
                  {s.name} {s.kind === "human" ? "🧑" : "🤖"}
                  {spec.seats.roleNames?.[i] ? ` (${spec.seats.roleNames[i]})` : ""}
                </span>
                <span className="score-value">{scores[i]}</span>
              </div>
            ))}
          </div>
        )}

        {!over && !busy && nextHuman && (() => {
          // The seat now on the move, and all of its axes still awaiting a pick.
          const seat = nextHuman.seat;
          const seatDecisions = humanDecisions.filter((d) => d.seat === seat && staged[d.key] === undefined);
          // With several humans sharing the screen, name whose turn it is.
          const whoseTurn = humanDecisions.some((d) => d.seat !== seat) && (
            <p>
              <strong>{seats[seat].name}</strong>
            </p>
          );
          // One axis → the familiar one-tap buttons (each explains itself in
          // its tooltip; a disabled option is greyed with its reason).
          if (seatDecisions.length <= 1) {
            return (
              <div className="action-row">
                {whoseTurn}
                <div className="row">
                  {nextHuman.choices.map((c) => (
                    <button
                      key={c.id}
                      className="primary"
                      disabled={c.disabled}
                      data-tip={c.detail}
                      onClick={() => stagePick(nextHuman.key, c.id)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          }
          // Several axes → radio groups the seat sets and commits together, so
          // both picks land in one step (no bots run in between).
          const ready = seatDecisions.every((d) => draft[d.key] !== undefined);
          return (
            <div className="action-row">
              {whoseTurn}
              {seatDecisions.map((d) => (
                <fieldset key={d.key} className="axis-group">
                  {d.prompt ? <legend>{d.prompt}</legend> : null}
                  <div className="row">
                    {d.choices.map((c) => (
                      <label
                        key={c.id}
                        className={`axis-option${c.disabled ? " disabled" : ""}`}
                        data-tip={c.detail}
                      >
                        <input
                          type="radio"
                          name={d.key}
                          disabled={c.disabled}
                          checked={draft[d.key] === c.id}
                          onChange={() => setDraft((prev) => ({ ...prev, [d.key]: c.id }))}
                        />
                        <span>{c.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
              <div className="row">
                <button className="primary" disabled={!ready} onClick={() => commitSeat(seatDecisions)}>
                  {nextHuman.commitLabel ?? "Confirm"}
                </button>
              </div>
            </div>
          );
        })()}

        {/* Manual all-LLM controls. When spectating (autoStart) the match plays
            itself, so these stay hidden unless auto-play has paused on an error
            and the run needs a nudge to resume. */}
        {!over && !busy && noHumans && anyBotPending && (!props.autoStart || autoPaused) && (
          <div className="action-row row">
            <button className="primary" onClick={() => void resolve({})}>
              Play round
            </button>
            <button onClick={() => void autoPlay()}>Auto-play to the end</button>
          </div>
        )}

        {!over && !busy && hasHuman && !nextHuman && anyBotPending && autoPaused && (
          <div className="action-row">
            <p className="muted small">A bot's turn didn't complete.</p>
            <div className="row">
              <button
                className="primary"
                onClick={() => {
                  setAutoPaused(false);
                  void resolve({});
                }}
              >
                Continue with {botSeatNames}
              </button>
            </div>
          </div>
        )}

        {busy && (
          <p className="thinking">
            {auto ? "Auto-playing… " : ""}
            <span className="spinner" /> Bots are thinking…
            {auto && (
              <button className="stop" onClick={() => (autoRef.current = false)}>
                Stop
              </button>
            )}
          </p>
        )}

        {over && <p className="final">{match.outcome().summary}</p>}

        {table && table.rows.length > 0 && (
          <table className="history-table">
            <thead>
              <tr>
                {table.columns.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Transcript entries={transcript} />
    </div>
  );
}
