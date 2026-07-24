import { useEffect, useRef } from "react";
import type { TranscriptEntry } from "../engine.js";
import { STR } from "../strings.js";

const S = STR.transcript;

export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [entries.length]);

  return (
    <div className="transcript">
      <h3>{S.title}</h3>
      <div className="transcript-scroll">
        {entries.length === 0 && <p className="muted small">{S.emptyPlaceholder}</p>}
        {entries.map((e, i) => (
          <div
            key={i}
            className={`transcript-entry transcript-${e.kind}${e.tone ? ` transcript-tone-${e.tone}` : ""}`}
          >
            <span className="transcript-meta">
              {e.tag ? `${e.tag}${S.metaSeparator}` : ""}
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
