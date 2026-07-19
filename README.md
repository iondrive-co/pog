# Player Other than Grunt

A React library for running turn-based strategic text games with [WebLLMs](https://github.com/mlc-ai/web-llm). 
See [RULES.md](RULES.md) for how to define a game. [AI Tycoon](https://iondrive.co/Aitycoon) has been built
with this library.

## Requirements

- **Node 18+** and npm (to build the library or run the demo).
- For LLM-controlled players: a **WebGPU-capable browser** — recent desktop Chrome or
  Edge (Safari 18+ and Firefox also work). The first model load downloads ~0.7–2 GB of
  weights, which the browser caches.

## Running the demo

The demo app in `demo/` runs Cartel: four producers in two teams share one market,
and each round every player floods it or withholds

```sh
npm install
npm run dev        # → open http://localhost:5173
```

WebGPU requires a secure context: `http://localhost` counts, but reaching the dev server
from **another machine** over plain HTTP does not. For that, use `npm run dev:https`
(self-signed certificate; accept the browser warning) or tunnel the port:
`ssh -L 5173:localhost:5173 <host>`.
