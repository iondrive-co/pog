/**
 * The built-in LLM backend: models running entirely in the browser via WebLLM
 * and WebGPU. This module owns the (single, shared) engine and exposes
 * `webLLMAgent`, a generic `Agent` that plays any DSL game over a JSON
 * protocol. Hosts with their own backend can ignore this file entirely and
 * implement `Agent` themselves.
 */

import type { MLCEngineInterface } from "@mlc-ai/web-llm";
import type { Agent, AgentReply, AgentRequest } from "../engine.js";

interface ModelInfo {
  /** WebLLM model_id stem (before the -q4f16_1-MLC / -q4f32_1-MLC suffix). */
  base: string;
  /** Human-friendly name for the picker — the raw model ids are opaque. */
  label: string;
  /**
   * Approximate GPU memory (MB) each build needs to load, taken from WebLLM's
   * prebuiltAppConfig `vram_required_MB`. The f32 builds need ~twice the memory
   * of the f16 ones. Used to label the picker and sort it smallest-first, so a
   * non-expert can pick by "how big" rather than by decoding the model name.
   */
  vramMB: { f16: number; f32: number };
}

/**
 * Small-ish models that follow instructions well enough to play. Hardcoded
 * (and checked against prebuiltAppConfig at load time) so the 6 MB web-llm
 * bundle can be imported lazily instead of shipping in the main chunk.
 * The q4f16 builds are half the download but need the shader-f16 WebGPU
 * feature; the q4f32 builds work on any adapter (e.g. Firefox without f16).
 */
const MODELS: ModelInfo[] = [
  { base: "SmolLM2-360M-Instruct", label: "SmolLM2 360M", vramMB: { f16: 376, f32: 580 } },
  { base: "Qwen2.5-0.5B-Instruct", label: "Qwen2.5 0.5B", vramMB: { f16: 945, f32: 1060 } },
  { base: "Llama-3.2-1B-Instruct", label: "Llama 3.2 1B", vramMB: { f16: 879, f32: 1129 } },
  { base: "Qwen2.5-1.5B-Instruct", label: "Qwen2.5 1.5B", vramMB: { f16: 1630, f32: 1889 } },
  { base: "SmolLM2-1.7B-Instruct", label: "SmolLM2 1.7B", vramMB: { f16: 1774, f32: 2692 } },
  { base: "gemma-2-2b-it", label: "Gemma 2 2B", vramMB: { f16: 1895, f32: 2509 } },
  { base: "Llama-3.2-3B-Instruct", label: "Llama 3.2 3B", vramMB: { f16: 2264, f32: 2952 } },
  { base: "Qwen2.5-3B-Instruct", label: "Qwen2.5 3B", vramMB: { f16: 2505, f32: 2894 } },
  { base: "Phi-3.5-mini-instruct", label: "Phi-3.5 mini (3.8B)", vramMB: { f16: 3672, f32: 5483 } },
];

/**
 * The default selection: small enough to load on modest/experimental GPUs
 * (Firefox included) yet still capable enough to follow the JSON protocol.
 * Users on very memory-constrained GPUs can drop to the sub-1B options above it.
 */
export const DEFAULT_MODEL_BASE = "Llama-3.2-1B-Instruct";

/**
 * Cap the KV cache well under the models' 4096-token default: a smaller cache
 * is meaningfully less GPU memory, which is exactly what tips a marginal load
 * from device-loss into success. Games with long rules/observations can raise
 * it via `loadModel`'s `contextWindowSize`.
 */
const DEFAULT_CONTEXT_WINDOW = 2048;

/**
 * Sampling temperature for the built-in agent. A little warmth keeps two seats
 * sharing one loaded model from playing in lockstep; the parse-failure retry
 * drops below this (see `RETRY_TEMPERATURE`) to coax out clean JSON.
 */
const DEFAULT_TEMPERATURE = 0.7;
const RETRY_TEMPERATURE = 0.3;

/**
 * How long generation may go without producing a token before the WebGPU device
 * is treated as lost. A working model keeps emitting tokens, each resetting this
 * watchdog, so it only trips on a genuine stall — a prefill or decode step that
 * never returns, which is the classic Firefox/Linux WebGPU device-loss hang.
 * Kept well above the worst-case time-to-first-token of the largest offered
 * model on a slow GPU, so it never cuts a merely-slow reply short.
 */
const DEFAULT_STALL_TIMEOUT_MS = 45_000;

/** Status of the shared model engine, for driving a loading UI. */
export interface EngineState {
  status: "idle" | "loading" | "ready" | "error";
  /** The model_ids currently resident in the engine (loaded together). */
  loaded: string[];
  progressText: string;
  progress: number; // 0..1
  error?: string;
}

/** A selectable model: the id to load, a friendly name, and its VRAM footprint. */
export interface ModelChoice {
  /** The WebLLM model_id to load. */
  id: string;
  /** The model family (model_id minus the build suffix) — what a seat stores. */
  base: string;
  /** Human-friendly name (e.g. "Llama 3.2 1B"). */
  label: string;
  /** Approximate GPU memory (MB) this build needs to load. */
  vramMB: number;
}

/** The selectable models for the current adapter, smallest (least VRAM) first. */
export function modelChoicesFor(f16: boolean): ModelChoice[] {
  return MODELS.map((m) => ({
    id: modelIdFor(m.base, f16),
    base: m.base,
    label: m.label,
    vramMB: f16 ? m.vramMB.f16 : m.vramMB.f32,
  })).sort((a, b) => a.vramMB - b.vramMB);
}

export function modelIdFor(base: string, f16: boolean): string {
  return `${base}-q4${f16 ? "f16" : "f32"}_1-MLC`;
}

export type GPUSupport =
  | { ok: true; f16: boolean }
  | { ok: false; reason: "insecure-context" | "no-api" | "no-adapter" };

interface MinimalGPUAdapter {
  features: { has(name: string): boolean };
}
interface MinimalGPU {
  requestAdapter(options?: {
    powerPreference?: "low-power" | "high-performance";
  }): Promise<MinimalGPUAdapter | null>;
}

/**
 * navigator.gpu is [SecureContext]: browsers hide it entirely on plain-HTTP
 * pages served from non-localhost hosts, so "no API" has two distinct causes.
 * And even when the API exists, requestAdapter() can return null (blocklisted
 * GPU/driver), so actually probe for an adapter.
 */
export async function checkWebGPU(): Promise<GPUSupport> {
  const gpu = (navigator as unknown as { gpu?: MinimalGPU }).gpu;
  if (!gpu) {
    return { ok: false, reason: window.isSecureContext ? "no-api" : "insecure-context" };
  }
  try {
    // Probe the same adapter WebLLM will request ("high-performance"), so the
    // shader-f16 flag we report matches the device it actually loads onto
    // rather than, say, an integrated GPU on a dual-GPU machine.
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { ok: false, reason: "no-adapter" };
    return { ok: true, f16: adapter.features.has("shader-f16") };
  } catch {
    return { ok: false, reason: "no-adapter" };
  }
}

let engine: MLCEngineInterface | null = null;
let worker: Worker | null = null;

/**
 * When the GPU device is lost mid-load (almost always out of memory), WebLLM
 * disposes its runtime and the in-flight load then throws a bare "Object has
 * already been disposed" — which hides the real cause. Detect that family of
 * failures and rethrow something the user can act on.
 */
function toLoadError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/disposed|device.*lost|out of memory|GPUOutOfMemory|maxBufferSize|maxStorageBuffer/i.test(msg)) {
    return new Error(
      "The GPU ran out of memory while loading this model, so the WebGPU device was lost. " +
        "Try a smaller model (e.g. Qwen2.5-0.5B or SmolLM2-360M) or, if a q4f16 build is " +
        "offered, prefer it — the q4f32 builds need about twice the memory. Note that " +
        "Firefox's WebGPU (especially on Linux) is experimental and more memory-constrained " +
        "than Chrome/Edge, so switching browser or closing other GPU-heavy tabs can also help.",
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

export interface LoadModelOptions {
  /**
   * Supply a Web Worker running the pog worker handler (`import "pog/worker"`)
   * so generation doesn't block the UI. Without one the engine runs on the
   * main thread — fully functional, but the page stutters while a model is
   * thinking. A factory (not an instance) because a failed load terminates the
   * worker and a retry needs a fresh one.
   */
  createWorker?: () => Worker;
  /** KV-cache size in tokens (default 2048); raise it for games with long prompts. */
  contextWindowSize?: number;
}

let createWorkerFn: (() => Worker) | undefined;
let loadedIds: string[] = [];

/**
 * Load exactly this set of models into the shared engine, replacing whatever
 * was resident before (WebLLM's reload semantics — there is no incremental
 * add). Several models share one engine and one GPU device; each seat's agent
 * then addresses its own via the per-request `model` field. Loading every
 * model a match needs in one call keeps the VRAM bill visible up front.
 */
export async function loadModels(
  modelIds: string[],
  onProgress: (text: string, progress: number) => void,
  options: LoadModelOptions = {},
): Promise<void> {
  if (modelIds.length === 0) throw new Error("No models to load");
  onProgress("Loading WebLLM runtime…", 0);
  const webllm = await import("@mlc-ai/web-llm");
  for (const id of modelIds) {
    if (!webllm.prebuiltAppConfig.model_list.some((m) => m.model_id === id)) {
      throw new Error(`Model ${id} is not in this WebLLM build's prebuilt list`);
    }
  }
  const chatOpts = modelIds.map(() => ({
    context_window_size: options.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW,
  }));
  if (options.createWorker) createWorkerFn = options.createWorker;

  loadedIds = [];
  if (!engine) {
    try {
      if (createWorkerFn) {
        worker = createWorkerFn();
        engine = await webllm.CreateWebWorkerMLCEngine(
          worker,
          modelIds,
          { initProgressCallback: (r) => onProgress(r.text, r.progress) },
          chatOpts,
        );
      } else {
        engine = await webllm.CreateMLCEngine(
          modelIds,
          { initProgressCallback: (r) => onProgress(r.text, r.progress) },
          chatOpts,
        );
      }
    } catch (err) {
      // The worker may have partially acquired a GPU device before failing
      // (e.g. device loss during weight upload); terminate it so the next
      // attempt spawns a genuinely fresh worker instead of leaking an
      // orphaned one that keeps holding the device.
      worker?.terminate();
      worker = null;
      engine = null;
      throw toLoadError(err);
    }
  } else {
    try {
      // The creation-time progress callback captured the first load's
      // closure; point the engine at this load's before reloading.
      engine.setInitProgressCallback((r) => onProgress(r.text, r.progress));
      await engine.reload(modelIds, chatOpts);
    } catch (err) {
      // A failed reload can leave the engine's internal state (and GPU
      // device) corrupted, so drop it rather than retrying against it.
      worker?.terminate();
      engine = null;
      worker = null;
      throw toLoadError(err);
    }
  }
  loadedIds = [...modelIds];
}

/** Load a single model (see `loadModels` — this replaces the loaded set). */
export async function loadModel(
  modelId: string,
  onProgress: (text: string, progress: number) => void,
  options: LoadModelOptions = {},
): Promise<void> {
  return loadModels([modelId], onProgress, options);
}

/**
 * The model_ids actually resident right now. This is the truth the UI should
 * re-sync from after a match: a mid-match GPU failure tears the engine down
 * (see `toGenerationError`), leaving nothing loaded no matter what a host's
 * cached state says.
 */
export function loadedModels(): string[] {
  return [...loadedIds];
}

/**
 * A generation-time failure that isn't a stall — usually the WebGPU device
 * being lost mid-decode ("Buffer unmapped", "device lost", out of memory).
 * After a device loss the engine has silently dropped its weights, so every
 * later request would throw ModelNotLoadedError. Tear the engine down so the
 * state is honest (nothing loaded, a future load starts fresh) and return an
 * error whose message the match transcript can usefully show.
 */
function toGenerationError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/unmapped|disposed|device.*lost|out of memory|GPUOutOfMemory|ModelNotLoaded/i.test(msg)) {
    worker?.terminate();
    worker = null;
    engine = null;
    loadedIds = [];
    return new Error(
      "the GPU device was lost mid-generation (usually out of memory), so the loaded models were dropped; " +
        "finish or exit this match, then reload a (smaller) model from the setup screen",
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

/**
 * Thrown by `chat` when generation stalls — no token for `stallMs`, which on a
 * marginal WebGPU device (notably Firefox on Linux) means the device has almost
 * certainly been lost mid-decode and will never produce another token. The
 * agent treats it like an unparseable reply: interrupt, fall back, keep playing,
 * rather than leaving the match awaiting a promise that can never settle.
 */
export class GenerationStalled extends Error {
  constructor(public readonly stallMs: number) {
    super(`the model produced no token for ${Math.round(stallMs / 1000)}s and was interrupted`);
    this.name = "GenerationStalled";
  }
}

/**
 * Stream one completion, accumulating the reply, guarded by a stall watchdog:
 * if no token arrives within `stallMs` — during prefill or mid-decode — the
 * device is treated as lost, the worker is interrupted to free the GPU, and the
 * call rejects with `GenerationStalled`. Streaming is what makes this possible:
 * a single non-streaming request gives no signal to tell "slow" from "hung", so
 * a lost device leaves the awaiting match hung forever. A merely-slow model
 * keeps yielding tokens, each rearming the watchdog, so it is never cut short.
 */
async function chat(
  system: string,
  user: string,
  temperature: number,
  maxTokens: number,
  stallMs: number,
  model?: string,
): Promise<string> {
  if (!engine) {
    throw new Error(
      "no model is loaded — it may have been dropped after a GPU failure; reload one from the setup screen",
    );
  }
  // With several models resident, WebLLM needs each request to name its model.
  if (model !== undefined && !loadedIds.includes(model)) {
    throw new Error(`Model ${model} is not loaded (loaded: ${loadedIds.join(", ") || "none"})`);
  }
  const active = engine;

  let content = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onStall: (err: Error) => void = () => {};
  const stalled = new Promise<never>((_, reject) => {
    onStall = reject;
  });
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // Best-effort nudge: if the decode loop is still alive it stops here and
      // releases the GPU; if the device is truly gone this is a no-op, but the
      // rejection below still frees the match from awaiting a dead promise.
      try {
        void active.interruptGenerate();
      } catch {
        // interrupting an already-dead engine is not itself an error
      }
      onStall(new GenerationStalled(stallMs));
    }, stallMs);
  };

  const drain = (async () => {
    const stream = await active.chat.completions.create({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      model,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    });
    for await (const chunk of stream) {
      arm(); // a token arrived — the device is alive; restart the watchdog
      content += chunk.choices[0]?.delta?.content ?? "";
    }
  })();
  // If the watchdog wins the race, `drain` may still reject later (e.g. a
  // device-lost error surfacing after we have moved on); swallow it so it never
  // becomes an unhandled rejection.
  drain.catch(() => {});

  try {
    arm(); // also covers prefill / time-to-first-token
    await Promise.race([drain, stalled]);
    return content;
  } catch (err) {
    // A stall keeps its own type (the agent falls back at once); anything else
    // is mapped — a device loss tears the engine down and gets an actionable
    // message, other errors pass through unchanged.
    throw err instanceof GenerationStalled ? err : toGenerationError(err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Pull the first parseable JSON object out of a model reply. */
function extractJSON(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/g, "");
  for (let start = cleaned.indexOf("{"); start !== -1; start = cleaned.indexOf("{", start + 1)) {
    let depth = 0;
    for (let i = start; i < cleaned.length; i++) {
      if (cleaned[i] === "{") depth++;
      else if (cleaned[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(cleaned.slice(start, i + 1));
            if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
          } catch {
            // keep scanning
          }
          break;
        }
      }
    }
  }
  return null;
}

function matchChoice(choices: AgentRequest["choices"], value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  for (const c of choices) {
    if (v === c.id.toLowerCase() || v === c.label.toLowerCase()) return c.id;
  }
  return null;
}

/**
 * Every string the built-in agent puts in front of the model, as templates.
 * Everything else the model sees comes from the game (rules, observation,
 * prompt, choices) — so the whole agent prompt is configuration, none of it
 * hardcoded.
 */
export interface AgentProtocol {
  /** Line introducing the list of options. */
  optionsHeader: string;
  /** One option in the list; {id} and {label} are available. */
  option: string;
  /** Used instead of `option` when the choice carries a detail note; adds {detail}. */
  optionWithDetail: string;
  /** The reply-format instruction; {ids} is the comma-separated list of legal ids. */
  instruction: string;
  /** Appended to the prompt when the previous reply could not be parsed. */
  retry: string;
  /** Logged as the reasoning when no reply parsed and a random choice was played. */
  unparsed: string;
  /** Logged as the reasoning when generation stalled (device lost) and a random choice was played. */
  stalled: string;
  /**
   * Logged as the reasoning when a choice parsed but no usable reasoning came
   * with it — the model left it blank or just parroted the template hint.
   */
  noReasoning: string;
}

export const DEFAULT_PROTOCOL: AgentProtocol = {
  optionsHeader: "Your options:",
  option: '- "{id}": {label}',
  optionWithDetail: '- "{id}": {label} — {detail}',
  instruction:
    "Respond with ONLY a JSON object and no other text:\n" +
    '{"reasoning": "<your reasoning, under 50 words>", "choice": "<one of: {ids}>"}',
  retry:
    "IMPORTANT: your previous reply could not be parsed. " +
    "Reply with exactly one JSON object in the format above.",
  unparsed: "(reply could not be parsed; a random choice was played instead)",
  stalled: "(the model stopped responding and was interrupted; a random choice was played instead)",
  noReasoning: "(no reasoning given)",
};

/** Fill {placeholders} in a protocol template. */
function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{([a-z][a-z0-9 ]*)\}/g, (m, key: string) => vars[key] ?? m);
}

export interface WebLLMAgentOptions {
  /**
   * The loaded model_id this agent generates with. Optional while a single
   * model is resident; required to disambiguate once several are loaded.
   */
  model?: string;
  /** Generation cap per decision (default 320 — reasoning is asked for in under 50 words). */
  maxTokens?: number;
  /**
   * How long generation may produce no token before the decision gives up and
   * plays a flagged random fallback (default 45000ms). Guards against a lost
   * WebGPU device hanging the match forever; see `GenerationStalled`.
   */
  stallTimeoutMs?: number;
  /** Overrides for the protocol wording (see `DEFAULT_PROTOCOL`). */
  protocol?: Partial<AgentProtocol>;
}

/**
 * An `Agent` backed by the shared in-browser model. Stateless per decision:
 * the game's rules + observation are sent fresh every time, which keeps two
 * seats sharing one model from leaking context into each other. Replies are
 * requested as JSON, parsed leniently, retried once at low temperature, and
 * fall back to a flagged random choice so a match can never get stuck.
 */
export function webLLMAgent(options: WebLLMAgentOptions = {}): Agent {
  const maxTokens = options.maxTokens ?? 320;
  const stallMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const proto: AgentProtocol = { ...DEFAULT_PROTOCOL, ...options.protocol };
  return {
    async choose(req: AgentRequest): Promise<AgentReply> {
      const system = req.rules.trim();
      const list = req.choices
        .map((c) =>
          fill(c.detail ? proto.optionWithDetail : proto.option, {
            id: c.id,
            label: c.label,
            detail: c.detail ?? "",
          }),
        )
        .join("\n");
      const ids = req.choices.map((c) => c.id).join(", ");
      // `req.prompt` is optional (a phase may have no `ask`); skip its paragraph
      // entirely when empty so the observation flows straight into the options.
      const promptBlock = req.prompt ? `${req.prompt}\n\n` : "";
      const ask =
        `${req.observation}\n\n${promptBlock}${proto.optionsHeader}\n${list}\n\n` +
        fill(proto.instruction, { ids });

      // The angle-bracket hint inside the JSON template, e.g. "your reasoning,
      // under 50 words". Small models sometimes copy it verbatim instead of
      // writing their own — spot that so it never lands in the transcript.
      const reasoningHint = (proto.instruction.match(/<([^>]*)>/)?.[1] ?? "").trim().toLowerCase();

      let stalledOut = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        let raw: string;
        try {
          raw = await chat(
            system,
            attempt === 0 ? ask : `${ask}\n\n${proto.retry}`,
            attempt === 0 ? DEFAULT_TEMPERATURE : RETRY_TEMPERATURE,
            maxTokens,
            stallMs,
            options.model,
          );
        } catch (err) {
          // A stall means the device is very likely gone — don't retry into the
          // same wedged engine; fall back at once so the match keeps moving.
          if (err instanceof GenerationStalled) {
            stalledOut = true;
            break;
          }
          throw err;
        }
        const parsed = extractJSON(raw);
        const choiceId = matchChoice(req.choices, parsed?.choice) ?? matchChoice(req.choices, raw.trim());
        if (choiceId) {
          const said = typeof parsed?.reasoning === "string" ? parsed.reasoning.trim() : "";
          // Ignore an empty reasoning or one that just echoes the template hint.
          const usable = said !== "" && !(reasoningHint !== "" && said.toLowerCase().includes(reasoningHint));
          return {
            choiceId,
            reasoning: usable ? said : proto.noReasoning,
            parseFailed: false,
          };
        }
      }

      const fallback = req.choices[Math.floor(Math.random() * req.choices.length)].id;
      return {
        choiceId: fallback,
        reasoning: stalledOut ? proto.stalled : proto.unparsed,
        parseFailed: true,
      };
    },
  };
}
