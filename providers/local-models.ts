import { z } from "zod";
import { stable, type AgentSetup, type Change } from "../harness/setup.ts";
import { completionMapper, DialectRegistry, type Dialect, type DialectSettings } from "./dialect.ts";
import { builtinDialects } from "./dialects/index.ts";
import { httpStream } from "./http.ts";
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

/** The settings of a local model: those of any Chat Completions server, and the dialect that renders the prompt itself (docs/local-models.md, section 9). */
export const localModelsSettings = compatibleSettings.extend({
  /** Render the prompt and read the output ourselves, through `/completion`, instead of the server's chat template. Absent: the server's template. */
  dialect: z.string().min(1).optional(),
  dialect_options: z.record(z.string(), z.unknown()).optional(),
});

/** What a setup change does: as for any server, and the dialect and its options change the prompt the server sees. */
export function classifyLocal(from: AgentSetup, to: AgentSetup): Change[] {
  const out = classifyCompatible(from, to);
  const f = (from.model?.settings ?? {}) as Record<string, unknown>;
  const t = (to.model?.settings ?? {}) as Record<string, unknown>;
  if (from.model !== undefined && to.model !== undefined && !out.some((c) => c.kind === "cache_break") && ["dialect", "dialect_options"].some((k) => stable(f[k] ?? null) !== stable(t[k] ?? null))) {
    out.push({ kind: "cache_break", message: "changing the dialect changes the prompt the server sees" });
  }
  return out;
}

/** The identity a request was served under; the part before `@` is what the server knows. */
export const modelNameOf = (id: string): string => id.split("@")[0] as string;

export interface LocalModelsExtras {
  /** The dialects available (default: the built-in ones). */
  dialects?: readonly Dialect[];
  /** Today, `YYYY-MM-DD` (default: the clock). */
  today?: () => string;
}

export function localModelsDefinition(runtime: LocalModelsRuntime, extras: LocalModelsExtras = {}) {
  const dialects = new DialectRegistry(extras.dialects ?? builtinDialects());
  const today = extras.today ?? (() => new Date().toISOString().slice(0, 10));
  return defineAdapter({
    $tag: "local-models",
    config: providerConfig,
    settings: localModelsSettings,
    jsonSchema: () => ({ config: z.toJSONSchema(providerConfig, { io: "input" }), settings: z.toJSONSchema(localModelsSettings, { io: "input" }) }),
    secrets: () => [],
    // Everything a local server costs is nothing, unless the config says otherwise.
    prices: (c) => pricesFor(undefined, { ...c, pricing: c.pricing ?? { free: true } }),
    models: (c) => modelsFor(runtime.catalog(), c),
    create: (c) => ({
      $tag: "local-models",
      classify: classifyLocal,
      stream(req: StreamRequest): ModelStream {
        return (async function* () {
          let conn: LocalModelsConnection;
          try {
            conn = await runtime.connect(req.signal);
          } catch (e) {
            throw new ProviderError({ kind: "network", message: e instanceof Error ? e.message : String(e), retryable: false, cause: e });
          }
          const settings = localModelsSettings.safeParse(req.setup.model?.settings ?? {});
          if (!settings.success) throw new ProviderError({ kind: "invalid_request", message: `invalid model settings for this provider: ${settings.error.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`).join("; ")}` });
          if (settings.data.dialect !== undefined) {
            const mapper = completionMapper(
              { baseUrl: conn.baseUrl, dialects, today, modelName: (id) => runtime.resolve(modelNameOf(id)), observe: (requested) => conn.ids[requested] },
              () => settings.data as DialectSettings,
            );
            return yield* httpStream(mapper, req, httpOptionsFor(c));
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
