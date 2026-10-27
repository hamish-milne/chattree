import { anthropicDefinition } from "./anthropic.ts";
import { openaiCompatibleDefinition } from "./openai-compatible.ts";
import { openaiDefinition } from "./openai-responses.ts";
import { AdapterRegistry } from "./registry.ts";

/** A registry with the adapters that ship with chattree. Add your own with `register`. */
export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(anthropicDefinition).register(openaiDefinition).register(openaiCompatibleDefinition);
}

export { AdapterRegistry, ProviderSetupError, buildProviders, defineAdapter, validateProviders, type AdapterDefinition, type BuiltProviders } from "./registry.ts";
export { costOf, effectiveTable, findModel, tableHash, type ModelPrice, type PriceTable } from "./pricing.ts";
export type { ModelInfo, ToolConvention } from "./registry.ts";
export { TOOL_CONVENTIONS } from "./registry.ts";
