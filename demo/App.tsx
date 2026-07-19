import { Arena, parseGame, type MatchUpdate } from "../src";
import cartelYaml from "./games/cartel.yaml?raw";

// The demo's game is authored entirely in YAML (demo/games/cartel.yaml): every
// sentence the players read and every number that tunes the economy. parseGame
// compiles it into a runnable game — edit the file and reload to change the game.
const CARTEL = parseGame(cartelYaml);

// Render a match snapshot as Markdown for the saved transcript file.
function formatMatch(u: MatchUpdate<unknown>): string {
  const players = u.seats
    .map((s, i) => {
      const role = u.spec.seats.roleNames?.[i];
      return `${s.name} (${s.kind}${role ? `, ${role}` : ""})`;
    })
    .join(", ");
  const lines = [
    `# ${u.spec.name} — ${new Date(u.startedAt).toLocaleString()}`,
    "",
    `Players: ${players}`,
    "",
    ...u.transcript.map((e) => `- ${e.tag ? `[${e.tag}] ` : ""}${e.author}: ${e.text}`),
  ];
  if (u.over && u.outcome) lines.push("", `**Result:** ${u.outcome.summary}`);
  lines.push("", `Scores: ${u.seats.map((s, i) => `${s.name} ${u.scores[i]}`).join(", ")}`);
  return lines.join("\n");
}

// Persist each match to /tmp for later review, via the dev-server middleware in
// vite.config.ts. One timestamped file per match, rewritten as it progresses;
// a no-op against a static build (there's no endpoint to POST to).
function saveTranscript(u: MatchUpdate<unknown>) {
  const stamp = new Date(u.startedAt).toISOString().replace(/[:.]/g, "-");
  void fetch("/__pog/transcript", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: `${u.spec.id}-${stamp}.md`, content: formatMatch(u) }),
  }).catch(() => {});
}

export default function App() {
  return (
    <div className="app">
      <header>
        <h1>Player Other than Grunt</h1>
        <p className="tagline">
        </p>
      </header>

      <Arena
        game={CARTEL}
        onMatchUpdate={saveTranscript}
        loadOptions={{
          // Keep generation off the main thread; without this the engine still
          // works but the page stutters while a model is thinking.
          createWorker: () =>
            new Worker(new URL("../src/webllm/worker.ts", import.meta.url), { type: "module" }),
        }}
      />

      <footer>
        <p className="muted small">
          Models run locally via{" "}
          <a href="https://github.com/mlc-ai/web-llm" target="_blank" rel="noreferrer">
            WebLLM
          </a>{" "}
          and WebGPU. No data leaves your device.
        </p>
      </footer>
    </div>
  );
}
