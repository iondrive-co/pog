# pog — architecture

pog is a library (not an app) for running turn-based, choice-driven text
games between humans and LLMs. **It ships no games**: consumers author a game as a YAML
game file compiled by `parseGame` (see [RULES.md](RULES.md)). The library currently
has multiple seats in teams, a persistent economy, a market price the moves push around,
and a secret end horizon, all authored in YAML (the phase machinery also supports multi-phase 
rounds; the demo game Cartel now uses a single one).

## Commands

```sh
npm run dev         # demo app at http://localhost:5173 (npm run dev:https for LAN/WebGPU)
npm run check       # type-check library + demo (tsconfig.json)
npm run build       # library → dist/ (tsconfig.lib.json + copies styles.css)
npm run demo:build  # demo static site → dist-demo/ (vite; never mixes into dist/)
npm test            # builds, then runs the node:test regression suite in test/
```

## Tests

`test/` holds `node:test` regression tests run against the built `dist/` (so `npm test`
builds first). The centrepiece is a **golden-transcript** test: `test/harness.mjs` drives a
whole match headlessly (a `Match` plus scripted agents, with `Math.random` seeded so the
secret horizon and `chance(…)` dice are reproducible) and compares the transcript to a
committed file under `test/golden/`. Cartel is the canary — a change that alters how any
game plays shows up as a golden diff. When a change *intentionally* alters play, regenerate
with `UPDATE_GOLDEN=1 npm test` and review the diff before committing. There are no test
dependencies; `node:test` is built in.

## Layout and layering

```
src/                    the library (published; src/ is also shipped for source maps/debugging)
  dsl.ts                DSL types + defineGame + defaultOptions. Pure types/data, no deps.
  gamefile.ts           the game-file compiler: validates a parsed YAML/JSON document and
                        interprets it as a GameSpec. It is a small state machine — named
                        `state` (global or per-seat), `derive`d formulas, `phases` whose
                        `resolve` blocks mutate state and narrate, a secret horizon, an
                        optional authored early end (`end when`), team scoring, and
                        authored `rules`/`observation`/`view` templates — with a tiny
                        expression language (multi-word names, min/max/clamp/floor, the
                        resolve-only dice roll chance(p), and the history built-ins
                        recent/tally) and `{placeholder}` templates. The only module
                        using the `yaml` dependency.
  engine.ts             Match runner + Agent interface + ruleAgent (plays a game's authored
                        `bot:` rules). Framework-free; depends only on dsl.
  config.ts             SeatConfig/MatchConfig + defaults — the shape the setup UI edits.
                        A seat is a name plus what plays it: a human, the game's rule-based
                        bot ("rules"), or an LLM (optionally naming its model family); an
                        LLM seat is driven purely by the game's generated rules.
  webllm/index.ts       The only module touching @mlc-ai/web-llm (lazily imported at runtime,
                        type-only at build). Shared engine singleton, GPU probing, and
                        webLLMAgent — the generic Agent speaking the JSON choice protocol.
                        Every string it puts in front of the model is configuration:
                        DEFAULT_PROTOCOL, overridable via WebLLMAgentOptions.protocol
                        (forwarded from ArenaProps.protocol).
  webllm/worker.ts      WebLLM worker handler; exported as "pog/worker".
  components/           React layer, thin over the engine:
    Arena.tsx           drop-in whole app for one game: ModelPanel + SetupPanel + MatchView.
    MatchView.tsx       runs one match of any spec (staging, step/auto-play, outcome, table).
    SetupPanel.tsx      spec-declared option knobs + N seat editors (name, human/LLM).
    ModelPanel.tsx      WebGPU check + model picker/loader.
    Transcript.tsx      reasoning/narration log.
  styles.css            plain CSS on class names + CSS variables; exported as "pog/styles.css".
demo/                   app shell + the Cartel demo game (demo/games/cartel.yaml), authored
                        entirely in YAML. NOT published, never imported by src/ — keep the
                        separation strict. (AI Tycoon used to live here too; it now ships as
                        its own app in the sibling `aitycoon` project, which depends on pog
                        as a library only — the reference example of consuming pog.)
```

Dependency direction: `dsl ← engine ← webllm ← components`; `config` feeds the components.
Nothing in `src/` may import from `demo/`.

## Key invariants

- **The game file is the authoring surface.** A non-technical person must be able to read
  and edit it; keep validation errors plain-English (say what's wrong and list the names
  available), and keep the LLM prose generated from the file so an edit can never
  desynchronise the rules from what players are told. All player-facing prose is
  YAML-authorable: never hardcode a new player-facing string in `src/`. Only the agent
  wire protocol (webllm's JSON instructions) and UI chrome stay in code.
- **Games are pure state machines.** `decisions()` returning an empty batch is the only
  end-of-game signal; `apply` is a pure reducer. The engine never interprets game rules.
  (Two deliberate impurities, both `Math.random()`: the secret horizon drawn in `init`
  from a game file's `end window`, and the `chance(p)` built-in a game file may call —
  only while a phase resolves, rolled into state so nothing re-rolls history.)
- **One batch = simultaneous.** All decisions in a `decisions()` batch are gathered
  against the pre-resolution state (agents queried sequentially but never shown another's
  pick; human picks staged hidden in MatchView) and resolved together by one `apply`. A
  game file's `phases` map onto these batches; a phase's `resolve` runs top-to-bottom so
  narration can see state as of its position.
- **Agents are pluggable.** `Agent.choose(request)` gets rules/observation/prompt/choices
  and returns a choice id + reasoning. The engine fails soft on an illegal agent choice
  (flagged random substitute) so a match can never get stuck, but throws on a missing or
  illegal *human* pick — that's a host bug.
- **LLM seats are stateless per decision** — the game's rules + observation are sent
  fresh every time, which keeps two agents sharing one loaded model from leaking context.

## Packaging notes (non-obvious)

- Exports: `pog` (dist/index.js), `pog/worker` (dist/webllm/worker.js),
  `pog/styles.css`. React/react-dom are peer deps; `@mlc-ai/web-llm` is a regular dep but
  only ever loaded via dynamic `import()` when a model is actually loaded.
- **Relative imports in `src/` must use explicit `.js` extensions** (e.g.
  `from "./dsl.js"`, `from "../webllm/index.js"`). tsc does not rewrite import paths, so
  this is what makes the emitted `dist/` valid ESM in node as well as bundlers. Vite and
  tsc both resolve `.js` back to `.ts`/`.tsx` during dev.
- **The library never constructs a Worker itself.** `new URL("./worker.ts",
  import.meta.url)` cannot survive tsc emit, and worker-in-dependency handling is flaky
  across bundlers — so hosts inject one via `loadModel`'s `createWorker` (a factory,
  because a failed load terminates the worker and a retry needs a fresh one). With no
  worker the engine runs on the main thread, which works but stutters during generation.
- Two tsconfigs: `tsconfig.json` (noEmit, checks src + demo), `tsconfig.lib.json`
  (emits dist from src only). Vite builds the demo to `dist-demo/` so `dist/` stays
  purely the library artifact that `files`/`exports` point at.
