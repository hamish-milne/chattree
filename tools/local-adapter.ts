import type { Io } from "../cli/io.ts";
import { localRuntime } from "../cli/providers.ts";
import { localModelsDefinition } from "../providers/index.ts";
import type { ProviderAdapter } from "../providers/types.ts";

/** The `local-models` provider as the CLI has it, for the live tools: it finds the model host through the settings and the running daemon. */
export function localModelsAdapter(io: Pick<Io, "host" | "env" | "settings">): ProviderAdapter {
  const def = localModelsDefinition(localRuntime(io));
  return def.create({ $tag: "local-models" }, { get: () => undefined });
}
