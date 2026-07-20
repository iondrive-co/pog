#!/usr/bin/env node
// Generates src/strings.ts from translations.yaml — the source of truth for
// every string the library puts on screen (plus the built-in agent's protocol
// wording). Runs automatically via the precheck/predev hooks, so a plain
// `npm run build` / `npm run dev` / `npm test` always compiles against the
// current translations.yaml.
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const root = new URL("..", import.meta.url);
const doc = parse(readFileSync(new URL("translations.yaml", root), "utf8"));

// "seat heading role suffix" → seatHeadingRoleSuffix
const camel = (key) =>
  key
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join("");

function emit(node, indent) {
  if (typeof node === "string") return JSON.stringify(node);
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    throw new Error(`translations.yaml: entries must be strings or nested maps, got ${JSON.stringify(node)}`);
  }
  const pad = "  ".repeat(indent);
  const inner = Object.entries(node)
    .map(([k, v]) => `${pad}  ${camel(k)}: ${emit(v, indent + 1)},`)
    .join("\n");
  return `{\n${inner}\n${pad}}`;
}

const out = `// GENERATED FILE — DO NOT EDIT.
// Source of truth: translations.yaml (repo root). Edit that file and rebuild;
// scripts/gen-strings.mjs rewrites this module before every check/build/dev.

/** Every user-facing string in the library, keyed by screen. */
export const STR = ${emit(doc, 0)} as const;

/**
 * Fill {placeholders} in a template from translations.yaml. Unknown keys stay
 * in place, so a template can carry literal braces (e.g. JSON examples).
 */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\\{([a-z][a-z0-9 ]*)\\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}
`;
writeFileSync(new URL("src/strings.ts", root), out);
console.log("generated src/strings.ts from translations.yaml");
