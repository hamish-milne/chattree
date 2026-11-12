/** Helpers for parsers that read a stream in arbitrary pieces and look for markers in it. */
import type { SchemaNode } from "./schema-tree.ts";

/** The earliest of the markers in the text, and where. */
export function nextMarker(buf: string, markers: readonly string[]): { at: number; marker: string } | undefined {
  let best: { at: number; marker: string } | undefined;
  for (const m of markers) {
    const at = buf.indexOf(m);
    if (at >= 0 && (best === undefined || at < best.at)) best = { at, marker: m };
  }
  return best;
}

/** How much of the text cannot be the start of a marker that is still arriving: the rest is held back until more comes. */
export function safeLength(buf: string, markers: readonly string[]): number {
  const longest = Math.max(...markers.map((m) => m.length));
  for (let k = Math.min(longest - 1, buf.length); k >= 1; k--) {
    const tail = buf.slice(buf.length - k);
    if (markers.some((m) => m.startsWith(tail))) return buf.length - k;
  }
  return buf.length;
}

/** Drops the whitespace at the start and end of a run of text, however it arrives in pieces; whitespace inside is kept. */
export class Trimmer {
  #lead = true;
  #held = "";
  push(text: string): string {
    let t = text;
    if (this.#lead) {
      t = t.trimStart();
      if (t === "") return "";
      this.#lead = false;
    }
    const s = this.#held + t;
    const body = s.trimEnd();
    this.#held = s.slice(body.length);
    return body;
  }
  reset(): void {
    this.#lead = true;
    this.#held = "";
  }
}

/** An argument written as text, as the schema says it should be: numbers, booleans and JSON structures are read; anything else stays text. */
export function coerce(text: string, schema: SchemaNode | undefined): unknown {
  const types = schema?.types ?? [];
  const asJson = (): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };
  if (types.includes("string") || (types.length === 0 && schema !== undefined)) return text;
  if (types.includes("integer") || types.includes("number")) {
    const n = Number(text.trim());
    return text.trim() !== "" && Number.isFinite(n) ? n : text;
  }
  if (types.includes("boolean")) return text.trim() === "true" ? true : text.trim() === "false" ? false : text;
  if (types.includes("array") || types.includes("object")) return asJson();
  if (schema === undefined) return /^\s*[[{]/.test(text) ? asJson() : text;
  return text;
}

/** JSON as the models' templates write it: a space after `,` and `:`. */
export function spacedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(spacedJson).join(", ")}]`;
  if (typeof v === "object" && v !== null) return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${spacedJson(x)}`).join(", ")}}`;
  return JSON.stringify(v) ?? "null";
}
