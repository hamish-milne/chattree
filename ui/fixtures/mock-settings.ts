/**
 * What the mock knows about the machine for the settings sheet: how reachable each provider is, the models a provider
 * lists, and the files in the workspace that could be instructions. The real controller asks the network and the file
 * system; here it is a table, so a test and the preview see the same thing.
 */
import type { InstructionState, ModelInfo, ProviderModels, ProviderStatus } from "../model/settings.ts";

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);

const CATALOG: Record<string, ModelInfo[]> = {
  anthropic: [
    { id: "claude-opus-5-5", context: 1_000_000, input_usd: 5, output_usd: 25, reasoning: true },
    { id: "claude-sonnet-5-5", context: 1_000_000, input_usd: 3, output_usd: 15, reasoning: true },
    { id: "claude-haiku-5-5", context: 200_000, input_usd: 1, output_usd: 5, reasoning: true },
  ],
  openai: [
    { id: "gpt-5.5", context: 400_000, input_usd: 1.25, output_usd: 10, reasoning: true },
    { id: "gpt-5.5-mini", context: 400_000, input_usd: 0.25, output_usd: 2, reasoning: true },
  ],
  gemini: [{ id: "gemini-3-pro", context: 1_000_000, input_usd: 2, output_usd: 12, reasoning: true }],
  "opencode-go": [{ id: "kimi-k2", context: 256_000 }],
};

/** A provider on this machine's own address cannot be reached in the mock (nothing is listening); the others can. */
export function mockProviderCheck(provider: unknown): { status: ProviderStatus; list: ProviderModels } {
  const p = isObject(provider) ? provider : {};
  const tag = typeof p["$tag"] === "string" ? p["$tag"] : "";
  const base = typeof p["base_url"] === "string" ? p["base_url"] : "";
  if (tag === "openai-compatible" && (base === "" || /localhost|127\.0\.0\.1/.test(base))) {
    const error = base === "" ? "no address set" : `connection refused at ${base}: is the server running?`;
    return { status: { state: "error", detail: error }, list: { models: [], error } };
  }
  const models = CATALOG[tag] ?? [];
  return {
    status: { state: "ok", detail: `${models.length} ${models.length === 1 ? "model" : "models"}`, ms: 180 + ((tag.length * 37) % 300) },
    list: { models },
  };
}

/** Files that exist in the mock workspace, with their sizes. */
export const WORKSPACE_FILES: Readonly<Record<string, number>> = {
  "AGENTS.md": 4210,
  "CLAUDE.md": 380,
  ".github/copilot-instructions.md": 1260,
  "CONTRIBUTING.md": 2890,
  "docs/conventions.md": 5120,
};
const WELL_KNOWN = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
  "CONVENTIONS.md",
  "CONTRIBUTING.md",
];

export function instructionsFixture(): InstructionState {
  return {
    files: [
      { path: "AGENTS.md", on: true, exists: true, bytes: WORKSPACE_FILES["AGENTS.md"] ?? 0 },
      { path: "docs/conventions.md", on: false, exists: true, bytes: WORKSPACE_FILES["docs/conventions.md"] ?? 0 },
    ],
    found: [],
  };
}

/** The state with `found` recomputed: well-known files that exist and are not among the files. */
export function withFound(state: InstructionState): InstructionState {
  const have = new Set(state.files.map((f) => f.path));
  return {
    files: state.files,
    found: WELL_KNOWN.filter((p) => p in WORKSPACE_FILES && !have.has(p)).map((path) => ({ path, bytes: WORKSPACE_FILES[path] ?? 0 })),
  };
}
