import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Dev-only: accept match transcripts POSTed by the demo and write one
// timestamped file per match under /tmp/pog-transcripts, for later review.
function pogTranscriptSaver(): Plugin {
  const dir = "/tmp/pog-transcripts";
  return {
    name: "pog-transcript-saver",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__pog/transcript", (req, res, next) => {
        if (req.method !== "POST") return next();
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const { filename, content } = JSON.parse(body) as { filename: string; content: string };
            const safe = String(filename).replace(/[^A-Za-z0-9._-]/g, "_");
            mkdirSync(dir, { recursive: true });
            const path = join(dir, safe);
            writeFileSync(path, String(content), "utf8");
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, path }));
          } catch (err) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        });
      });
    },
  };
}

// WebGPU requires a secure context, but http://localhost (and 127.0.0.1)
// counts as secure even over plain HTTP, so local dev defaults to HTTP.
// Set POG_HTTPS=1 (or use `npm run dev:https`) for self-signed HTTPS if you
// need to reach the dev server from another device on the LAN, where only
// HTTPS counts as secure.
const useHttps = process.env.POG_HTTPS === "1";

export default defineConfig({
  plugins: [react(), pogTranscriptSaver(), ...(useHttps ? [basicSsl()] : [])],
  server: {
    host: true,
    port: 5173,
    // Fail loudly on a port conflict instead of silently moving to a port
    // that may not be open in your firewall/tunnel/port-forward.
    strictPort: true,
  },
  preview: {
    host: true,
    strictPort: true,
  },
  build: {
    // Keep the demo build out of dist/, which belongs to the library build.
    outDir: "dist-demo",
    target: "esnext",
    // The WebLLM runtime is a single ~6 MB chunk, loaded lazily (and again
    // inside the worker). Nothing to split further; raise the limit for it.
    chunkSizeWarningLimit: 6500,
  },
});
