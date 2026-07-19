import { useEffect, useRef } from "react";
import type { TranscriptEntry } from "../engine.js";

export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [entries.length]);

  return (
    <div className="transcript">
      <h3>Transcript</h3>
      <div className="transcript-scroll">
        {entries.length === 0 && <p className="muted small">Player reasoning will appear here.</p>}
        {entries.map((e, i) => (
          <div key={i} className={`transcript-entry transcript-${e.kind}`}>
            <span className="transcript-meta">
              {e.tag ? `${e.tag} · ` : ""}
              {e.author}
            </span>
            <p>{e.text}</p>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
