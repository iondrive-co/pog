import { useState } from "react";
import { STR, fmt } from "../strings.js";
import {
  loadModels,
  DEFAULT_MODEL_BASE,
  type EngineState,
  type GPUSupport,
  type LoadModelOptions,
  type ModelChoice,
} from "../webllm/index.js";

const S = STR.modelPanel;

const GPU_MESSAGES: Record<Extract<GPUSupport, { ok: false }>["reason"], string> = {
  "insecure-context": S.gpuInsecureContext,
  "no-api": S.gpuNoApi,
  "no-adapter": S.gpuNoAdapter,
};

/**
 * The model library: pick a model and load it. Each load ADDS to the loaded
 * set (all loaded models share the GPU at once), and only loaded models can be
 * handed a seat in the setup panel below. Loading nothing is fine — human and
 * rule-based seats play without a model.
 */
export function ModelPanel(props: {
  engine: EngineState;
  setEngine: (s: EngineState) => void;
  gpu: GPUSupport | null;
  /** The selectable models for this adapter, display-ready. */
  models: ModelChoice[];
  /** Forwarded to `loadModels` — supply `createWorker` to keep generation off the main thread. */
  loadOptions?: LoadModelOptions;
}) {
  const { engine, setEngine, gpu, models, loadOptions } = props;
  const [base, setBase] = useState(DEFAULT_MODEL_BASE);

  const gpuOk = gpu?.ok === true;
  const chosen = models.find((m) => m.base === base);
  const alreadyLoaded = chosen !== undefined && engine.loaded.includes(chosen.id);
  const loadedLabels = engine.loaded.map((id) => models.find((m) => m.id === id)?.label ?? id);

  const load = async () => {
    if (!chosen) return;
    // WebLLM has no incremental add — reload the union so everything already
    // loaded stays loaded alongside the new model.
    const ids = [...engine.loaded.filter((id) => id !== chosen.id), chosen.id];
    const before = engine.loaded;
    setEngine({ status: "loading", loaded: before, progressText: S.progressStarting, progress: 0 });
    try {
      await loadModels(
        ids,
        (text, progress) => setEngine({ status: "loading", loaded: before, progressText: text, progress }),
        loadOptions,
      );
      setEngine({ status: "ready", loaded: ids, progressText: S.progressReady, progress: 1 });
    } catch (err) {
      // A failed (re)load drops everything — reflect that honestly.
      setEngine({
        status: "error",
        loaded: [],
        progressText: "",
        progress: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <section className="card">
      <div className="card-title">
        <h2>{S.title}</h2>
        {engine.loaded.length > 0 && (
          <span className="chip chip-ok">{fmt(S.loadedChip, { models: loadedLabels.join(", ") })}</span>
        )}
      </div>
      {gpu === null && <p className="muted small">{S.checkingGpu}</p>}
      {gpu !== null && !gpu.ok && <p className="warning">{GPU_MESSAGES[gpu.reason]}</p>}
      <div className="row">
        <select value={base} onChange={(e) => setBase(e.target.value)} disabled={engine.status === "loading"}>
          {models.map((m) => (
            <option key={m.base} value={m.base}>
              {fmt(S.modelOption, { model: m.label, size: (m.vramMB / 1024).toFixed(1) })}
              {engine.loaded.includes(m.id) ? S.modelOptionLoadedSuffix : ""}
            </option>
          ))}
        </select>
        <button
          className="primary"
          onClick={load}
          disabled={!gpuOk || engine.status === "loading" || alreadyLoaded}
        >
          {alreadyLoaded
            ? S.loadedButton
            : engine.status === "loading"
              ? S.loadingButton
              : engine.loaded.length > 0
                ? S.loadAnotherButton
                : S.loadButton}
        </button>
      </div>
      {engine.status === "loading" && (
        <div className="progress-wrap">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${Math.round(engine.progress * 100)}%` }} />
          </div>
          <p className="muted small">{engine.progressText}</p>
        </div>
      )}
      {engine.status === "error" && (
        <p className="warning">{fmt(S.loadFailed, { error: engine.error ?? "" })}</p>
      )}
      {engine.status === "idle" && gpuOk && <p className="muted small">{S.idleHint}</p>}
    </section>
  );
}
