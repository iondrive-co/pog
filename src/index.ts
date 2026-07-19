// The DSL: define games as data + pure functions.
export * from "./dsl.js";

// Game files: whole games defined in editable YAML/JSON documents.
export * from "./gamefile.js";

// The engine: run a match, plug in agents.
export * from "./engine.js";

// Seat/match configuration shared by the setup UI and the Arena.
export * from "./config.js";

// The in-browser WebLLM backend (lazy-loaded; unused unless a model is loaded).
export * from "./webllm/index.js";

// React components: drop in <Arena> whole, or compose the panels yourself.
export { Arena, type ArenaProps } from "./components/Arena.js";
export { MatchView, type MatchViewProps, type MatchUpdate } from "./components/MatchView.js";
export { SetupPanel, type SetupPanelProps } from "./components/SetupPanel.js";
export { ModelPanel } from "./components/ModelPanel.js";
export { Transcript } from "./components/Transcript.js";
