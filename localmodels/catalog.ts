/**
 * The settings seen as a provider catalog and as agent setup: the models the settings name, with their context size and sampling, and
 * how a name or an alias resolves to the model's own name. Pure: it reads the settings and nothing else, so the catalog and the agent
 * setup agree with what config.ts parsed.
 */
import type { ModelInfo } from "../providers/registry.ts";
import type { LocalModels, Sampling } from "./config.ts";

/** What the settings say about each model, under its name and each of its aliases. */
export function catalog(config: LocalModels): Record<string, ModelInfo> {
  const out: Record<string, ModelInfo> = {};
  for (const [name, m] of Object.entries(config.models)) {
    const ctx = m.ctx_size ?? config.defaults.ctx_size;
    const info: ModelInfo = {
      ...(ctx === undefined ? {} : { context_window: ctx }),
      ...(m.description === undefined ? {} : { description: m.description }),
      ...(m.tool_convention === undefined ? {} : { tool_convention: m.tool_convention }),
    };
    for (const id of [name, ...(m.aliases ?? [])]) out[id] = info;
  }
  return out;
}

/** The model's own name for a name or alias; an unknown id is returned as it is, for the server to refuse. */
export function resolveName(config: LocalModels, id: string): string {
  if (config.models[id] !== undefined) return id;
  for (const [name, m] of Object.entries(config.models)) if (m.aliases?.includes(id) === true) return name;
  return id;
}

/**
 * The sampling pinned in the agent setup, as the OpenAI-compatible adapter's model settings (the ones it has no field for go in `extra`).
 */
export function samplingSettings(s: Sampling | undefined): { temperature?: number; top_p?: number; extra?: Record<string, number> } {
  if (s === undefined) return {};
  const extra: Record<string, number> = {};
  for (const k of ["top_k", "min_p", "repeat_penalty", "presence_penalty", "frequency_penalty"] as const)
    if (s[k] !== undefined) extra[k] = s[k];
  return {
    ...(s.temperature === undefined ? {} : { temperature: s.temperature }),
    ...(s.top_p === undefined ? {} : { top_p: s.top_p }),
    ...(Object.keys(extra).length === 0 ? {} : { extra }),
  };
}
