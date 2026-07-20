// GENERATED FILE — DO NOT EDIT.
// Source of truth: translations.yaml (repo root). Edit that file and rebuild;
// scripts/gen-strings.mjs rewrites this module before every check/build/dev.

/** Every user-facing string in the library, keyed by screen. */
export const STR = {
  setupPanel: {
    title: "{game name} — match setup",
    badgeHuman: "🧑",
    badgeBot: "🤖",
    seatHeading: "Player {n}",
    seatHeadingRoleSuffix: " — {role}",
    removeSeatButton: "Remove",
    nameLabel: "Name",
    playedByLabel: "Played by",
    humanOption: "You",
    ruleBasedOption: "Rule-based - no model",
    modelOption: "{model} — ~{size} GB VRAM",
    modelOptionUnloadedSuffix: " (load it above)",
    addPlayerButton: "Add player",
    startButton: "Start match",
    spectatingNote: "Humans have been removed (from this game).",
    needsModelNote: "Load the models above to start.",
  },
  modelPanel: {
    title: "Models",
    loadedChip: "✓ {models}",
    checkingGpu: "Checking WebGPU support…",
    gpuInsecureContext: "WebGPU is hidden because this page was loaded over plain HTTP from a non-localhost address (browsers only expose the API in a secure context). Open this app via http://localhost instead, or run `npm run dev:https` and accept the self-signed certificate if you need to reach it from another device on the LAN.",
    gpuNoApi: "This browser doesn't expose WebGPU. Recent desktop Chrome and Edge enable it by default, as do current Firefox releases (on Linux you may need dom.webgpu.enabled in about:config) and Safari 18+.",
    gpuNoAdapter: "WebGPU is available, but the browser returned no GPU adapter — the GPU or its driver is likely blocklisted. Check about:gpu in Chrome or the Graphics section of about:support in Firefox.",
    modelOption: "{model} — ~{size} GB VRAM",
    modelOptionLoadedSuffix: " ✓",
    loadButton: "Load model",
    loadAnotherButton: "Load another model",
    loadingButton: "Loading…",
    loadedButton: "Loaded",
    progressStarting: "Starting…",
    progressRuntime: "Loading WebLLM runtime…",
    progressReady: "Models ready",
    loadFailed: "Failed to load models: {error}",
    idleHint: "Load a model to play against an LLM rather than the default rules based agent. Each model downloads once and is cached by your browser.",
  },
  matchView: {
    title: "{game name} — {status}",
    newMatchButton: "New match",
    seatRoleSuffix: " ({role})",
    defaultCommitButton: "Confirm",
    playRoundButton: "Play round",
    autoplayButton: "Auto-play to the end",
    botStalledNote: "A bot's turn didn't complete.",
    continueButton: "Continue with {bot names}",
    autoplaying: "Auto-playing… ",
    thinking: "Bots are thinking…",
    stopButton: "Stop",
    errorEntry: "Error: {message}",
    errorAuthor: "System",
  },
  transcript: {
    title: "Transcript",
    emptyPlaceholder: "Player reasoning will appear here.",
    metaSeparator: " · ",
  },
  engine: {
    agentFailed: "(the agent failed — {error} — so a random choice was played instead)",
    agentIllegalChoice: "(the agent chose \"{choice}\", which is not a legal option; a random choice was played instead)",
    narrationAuthor: "Result",
    defaultHumanSeat: "Player {n}",
    defaultBotSeat: "Bot {n}",
    defaultMaskedSecret: "?",
  },
  llmAgent: {
    unparsedReply: "(reply could not be parsed; a random choice was played instead)",
    stalledReply: "(the model stopped responding and was interrupted; a random choice was played instead)",
    noReasoning: "(no reasoning given)",
    promptOnly: {
      optionsHeader: "Your options:",
      option: "- \"{id}\": {label}",
      optionWithDetail: "- \"{id}\": {label} — {detail}",
      instruction: "Respond with ONLY a JSON object and no other text:\n{\"reasoning\": \"<your reasoning, under 50 words>\", \"choice\": \"<one of: {ids}>\"}",
      retry: "IMPORTANT: your previous reply could not be parsed. Reply with exactly one JSON object in the format above.",
    },
  },
  errors: {
    gpuOutOfMemory: "The GPU ran out of memory while loading this model, so the WebGPU device was lost. Try a smaller model (e.g. Qwen2.5-0.5B or SmolLM2-360M) or, if a q4f16 build is offered, prefer it — the q4f32 builds need about twice the memory. Note that Firefox's WebGPU (especially on Linux) is experimental and more memory-constrained than Chrome/Edge, so switching browser or closing other GPU-heavy tabs can also help.",
    noModelLoaded: "no model is loaded — it may have been dropped after a GPU failure; reload one from the setup screen",
    modelNotLoaded: "Model {model} is not loaded (loaded: {ids})",
    modelNotLoadedNone: "none",
    noModelsToLoad: "No models to load",
    modelNotPrebuilt: "Model {id} is not in this WebLLM build's prebuilt list",
    generationStalled: "the model produced no token for {seconds}s and was interrupted",
  },
} as const;

/**
 * Fill {placeholders} in a template from translations.yaml. Unknown keys stay
 * in place, so a template can carry literal braces (e.g. JSON examples).
 */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([a-z][a-z0-9 ]*)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}
