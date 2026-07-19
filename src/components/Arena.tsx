import { useEffect, useMemo, useState } from "react";
import type { GameSpec } from "../dsl.js";
import { defaultMatchConfig, type MatchConfig, type SeatConfig } from "../config.js";
import type { Agent } from "../engine.js";
import {
  checkWebGPU,
  loadedModels,
  modelChoicesFor,
  modelIdFor,
  webLLMAgent,
  DEFAULT_MODEL_BASE,
  type AgentProtocol,
  type EngineState,
  type GPUSupport,
  type LoadModelOptions,
} from "../webllm/index.js";
import { ModelPanel } from "./ModelPanel.js";
import { SetupPanel } from "./SetupPanel.js";
import { MatchView, type MatchUpdate } from "./MatchView.js";

export interface ArenaProps {
  /** The game to play — a DSL `GameSpec` (e.g. from `parseGame`). */
  game: GameSpec<never> | GameSpec<unknown>;
  /**
   * Builds the Agent for an LLM seat. Defaults to the in-browser WebLLM agent;
   * pass your own to play seats against any other backend (in which case the
   * model panel is hidden). Rule-based seats never reach this — they play the
   * game's own authored `bot` rules.
   */
  agentFor?: (seat: SeatConfig, index: number) => Agent;
  /** Forwarded to the model panel's `loadModels` (e.g. `createWorker`). */
  loadOptions?: LoadModelOptions;
  /** Overrides for the built-in agent's protocol wording (see `DEFAULT_PROTOCOL`). */
  protocol?: Partial<AgentProtocol>;
  /** Called after each step and at game over with a snapshot of the running match. */
  onMatchUpdate?: (update: MatchUpdate<unknown>) => void;
}

/**
 * The whole app in one component: model loader, match setup, and match runner
 * for one DSL game. Hosts that want a different layout can compose `ModelPanel`,
 * `SetupPanel`, and `MatchView` themselves.
 */
export function Arena(props: ArenaProps) {
  const spec = props.game as GameSpec<unknown>;
  const { loadOptions } = props;

  // One GPU probe for the whole app: the setup panel labels models by the
  // adapter's builds (f16 vs f32) and the model panel explains failures.
  const [gpu, setGpu] = useState<GPUSupport | null>(null);
  useEffect(() => {
    let cancelled = false;
    void checkWebGPU().then((support) => {
      if (!cancelled) setGpu(support);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const f16 = gpu?.ok ? gpu.f16 : true;
  const models = useMemo(() => modelChoicesFor(f16), [f16]);

  const [engine, setEngine] = useState<EngineState>({
    status: "idle",
    loaded: [],
    progressText: "",
    progress: 0,
  });
  const [config, setConfig] = useState<MatchConfig>(() => defaultMatchConfig(spec));
  const [inMatch, setInMatch] = useState(false);

  const usesWebLLM = !props.agentFor;

  // Seats store a model family (base); the adapter decides the actual build.
  const modelIdOf = (seat: SeatConfig): string => modelIdFor(seat.model ?? DEFAULT_MODEL_BASE, f16);

  // The distinct models the current line-up needs resident before a match —
  // rule-based and human seats need none. Normally every LLM seat already
  // holds a loaded model (the setup panel only offers loaded ones); this still
  // gates Start for configs that predate a load (e.g. a game without bot rules
  // defaulting its seats to the default model).
  const needed = useMemo(
    () => [...new Set(config.seats.filter((s) => s.kind === "llm").map(modelIdOf))],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- modelIdOf varies with f16
    [config.seats, f16],
  );

  const agentFor = useMemo(
    () =>
      props.agentFor ??
      ((seat: SeatConfig) => webLLMAgent({ protocol: props.protocol, model: modelIdOf(seat) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- modelIdOf varies with f16
    [props.agentFor, props.protocol, f16],
  );

  const missing = needed.filter((id) => !engine.loaded.includes(id));
  const canStart = !usesWebLLM || missing.length === 0;

  return (
    <>
      {!inMatch && (
        <>
          {usesWebLLM && (
            <ModelPanel
              engine={engine}
              setEngine={setEngine}
              gpu={gpu}
              models={models}
              loadOptions={loadOptions}
            />
          )}
          <SetupPanel
            game={spec}
            config={config}
            setConfig={setConfig}
            models={usesWebLLM ? models : []}
            defaultModel={DEFAULT_MODEL_BASE}
            loadedIds={engine.loaded}
            canStart={canStart}
            needsModel={!canStart}
            onStart={() => setInMatch(true)}
          />
        </>
      )}
      {inMatch && (
        <MatchView
          spec={spec}
          seats={config.seats}
          options={config.options}
          agentFor={agentFor}
          // No human seat = spectating: play the whole match out automatically.
          autoStart={config.seats.every((s) => s.kind !== "human")}
          onExit={() => {
            setInMatch(false);
            // Re-sync from the backend's truth: a mid-match GPU failure tears
            // the engine down, so models the panel thinks are loaded may be
            // gone — the setup screen must reflect that before the next match.
            if (usesWebLLM) {
              const actual = loadedModels();
              if (actual.length !== engine.loaded.length) {
                setEngine({
                  status: actual.length > 0 ? "ready" : "idle",
                  loaded: actual,
                  progressText: "",
                  progress: 0,
                });
              }
            }
          }}
          onUpdate={props.onMatchUpdate}
        />
      )}
    </>
  );
}
