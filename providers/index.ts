/**
 * Public entry point of the providers directory. Re-exports the registry, pricing and local-model helpers that callers use,
 * and defines the default registry of shipped adapters. Local models are deliberately not in that default set: their adapter
 * needs a running server and a runtime, so callers register it themselves (see `localModelsDefinition`).
 */

import { anthropicDefinition } from "./anthropic.ts";
import { geminiDefinition } from "./gemini.ts";
import { opencodeGoDefinition } from "./opencode-go.ts";
import { openaiCompatibleDefinition } from "./openai-compatible.ts";
import { openaiDefinition } from "./openai-responses.ts";
import { AdapterRegistry } from "./registry.ts";

/** A registry with the adapters that ship with chattree. Add your own with `register`. */
export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .register(anthropicDefinition)
    .register(openaiDefinition)
    .register(openaiCompatibleDefinition)
    .register(opencodeGoDefinition)
    .register(geminiDefinition);
}

export {
  AdapterRegistry,
  ProviderSetupError,
  buildProviders,
  defineAdapter,
  settingsProblems,
  validateProviders,
  type AdapterDefinition,
  type BuiltProviders,
} from "./registry.ts";
export { costOf, effectiveTable, findModel, tableHash, type ModelPrice, type PriceTable } from "./pricing.ts";
export type { ModelInfo, ToolConvention } from "./registry.ts";
export { TOOL_CONVENTIONS, TOOL_SCHEMAS } from "./registry.ts";
export { localModelsDefinition, modelNameOf, type LocalModelsConnection, type LocalModelsRuntime } from "./local-models.ts";
