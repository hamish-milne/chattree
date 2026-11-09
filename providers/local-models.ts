import { z } from "zod";
import { classifyCompatible, compatibleSettings, openaiCompatibleAdapter } from "./openai-compatible.ts";
import { commonProviderFields, defineAdapter, httpOptionsFor, modelsFor, pricesFor, type ModelInfo } from "./registry.ts";
import { ProviderError, type ModelStream, type StreamRequest } from "./types.ts";

/**
 * The models chattree runs itself (docs/local-models.md, section 6). The provider has no address in `harness.yml`: the host chooses its
 * port when it starts, so the address, the catalog and the model identities all come from a runtime that the application provides
 * (the CLI builds it from the settings file and the running host). Requests are the OpenAI-compatible ones of llama-server; the model
 * recorded as having served a request is `name@hash8`, so the history says exactly which file answered.
 */

export interface LocalModelsConnection {
  /** The server's address, without `/v1`. */
  baseUrl: string;
  /** Model name to its identity, `name@hash8`, for the models whose files are known. */
  ids: Readonly<Record<string, string>>;
}

export interface LocalModelsRuntime {
  /** Where the host is now. Throws an `Error` whose message says what to do when it is not running. */
  connect(signal?: AbortSignal): Promise<LocalModelsConnection>;
  /** The models of the settings, by name and by alias. */
  catalog(): Record<string, ModelInfo>;
  /** The model's own name for a name or alias (what the server is asked for). */
  resolve(id: string): string;
}

const providerConfig = z.strictObject({
  $tag: z.literal("local-models"),
  include_usage: z.boolean().optional(),
  ...commonProviderFields,
});

/** The identity a request was served under; the part before `@` is what the server knows. */
export const modelNameOf = (id: string): string => id.split("@")[0] as string;

export function localModelsDefinition(runtime: LocalModelsRuntime) {
  return defineAdapter({
    $tag: "local-models",
    config: providerConfig,
    settings: compatibleSettings,
    jsonSchema: () => ({ config: z.toJSONSchema(providerConfig, { io: "input" }), settings: z.toJSONSchema(compatibleSettings, { io: "input" }) }),
    secrets: () => [],
    // Everything a local server costs is nothing, unless the config says otherwise.
    prices: (c) => pricesFor(undefined, { ...c, pricing: c.pricing ?? { free: true } }),
    models: (c) => modelsFor(runtime.catalog(), c),
    create: (c) => ({
      $tag: "local-models",
      classify: classifyCompatible,
      stream(req: StreamRequest): ModelStream {
        return (async function* () {
          let conn: LocalModelsConnection;
          try {
            conn = await runtime.connect(req.signal);
          } catch (e) {
            throw new ProviderError({ kind: "network", message: e instanceof Error ? e.message : String(e), retryable: false, cause: e });
          }
          const inner = openaiCompatibleAdapter({
            tag: "local-models",
            baseUrl: `${conn.baseUrl}/v1`,
            ...(c.include_usage === undefined ? {} : { includeUsage: c.include_usage }),
            modelName: (id) => runtime.resolve(modelNameOf(id)),
            observe: (requested, reported) => conn.ids[requested] ?? reported,
            http: httpOptionsFor(c),
          });
          return yield* inner.stream(req);
        })();
      },
    }),
  });
}
