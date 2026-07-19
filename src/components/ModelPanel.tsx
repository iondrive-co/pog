import { useState } from "react";
import {
  loadModels,
  DEFAULT_MODEL_BASE,
  type EngineState,
  type GPUSupport,
  type LoadModelOptions,
  type ModelChoice,
} from "../webllm/index.js";

const GPU_MESSAGES: Record<Extract<GPUSupport, { ok: false }>["reason"], string> = {
  "insecure-context":
    "WebGPU is hidden because this page was loaded over plain HTTP from a non-localhost " +
    "address (browsers only expose the API in a secure context). Open this app via " +
    "http://localhost instead, or run `npm run dev:https` and accept the self-signed " +
    "certificate if you need to reach it from another device on the LAN.",
  "no-api":
    "This browser doesn't expose WebGPU. Recent desktop Chrome and Edge enable it by " +
    "default, as do current Firefox releases (on Linux you may need dom.webgpu.enabled in " +
    "about:config) and Safari 18+.",
  "no-adapter":
    "WebGPU is available, but the browser returned no GPU adapter — the GPU or its driver " +
    "is likely blocklisted. Check about:gpu in Chrome or the Graphics section of " +
    "about:support in Firefox.",
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
    setEngine({ status: "loading", loaded: before, progressText: "Starting…", progress: 0 });
    try {
      await loadModels(
        ids,
        (text, progress) => setEngine({ status: "loading", loaded: before, progressText: text, progress }),
        loadOptions,
      );
      setEngine({ status: "ready", loaded: ids, progressText: "Models ready", progress: 1 });
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
        <h2>Models</h2>
        {engine.loaded.length > 0 && <span className="chip chip-ok">✓ {loadedLabels.join(", ")}</span>}
      </div>
      {gpu === null && <p className="muted small">Checking WebGPU support…</p>}
      {gpu !== null && !gpu.ok && <p className="warning">{GPU_MESSAGES[gpu.reason]}</p>}
      {gpu?.ok && !gpu.f16 && (
        <p className="muted small">
          This GPU/browser doesn't support shader-f16, so the f32 model builds are listed
          (same models, roughly twice the download).
        </p>
      )}
      <div className="row">
        <select value={base} onChange={(e) => setBase(e.target.value)} disabled={engine.status === "loading"}>
          {models.map((m) => (
            <option key={m.base} value={m.base}>
              {m.label} — ~{(m.vramMB / 1024).toFixed(1)} GB VRAM
              {engine.loaded.includes(m.id) ? " ✓" : ""}
            </option>
          ))}
        </select>
        <button
          className="primary"
          onClick={load}
          disabled={!gpuOk || engine.status === "loading" || alreadyLoaded}
        >
          {alreadyLoaded
            ? "Loaded"
            : engine.status === "loading"
              ? "Loading…"
              : engine.loaded.length > 0
                ? "Load another model"
                : "Load model"}
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
      {engine.status === "error" && <p className="warning">Failed to load models: {engine.error}</p>}
      {engine.status === "idle" && gpuOk && (
        <p className="muted small">
          Load a model to hand it a seat below — human and rule-based seats need none. Each
          model downloads once and is cached by your browser; the size beside each name is
          roughly the GPU memory it needs, and every loaded model must fit at the same time.
          Everything runs on your device — nothing is sent to a server.
        </p>
      )}
    </section>
  );
}
