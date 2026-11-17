import { Type, type Static, type StaticDecode, type TSchema } from "typebox";
import type { Issue } from "../src/errors.ts";
import { pattern, record, rules, safeParse, strictObject } from "../src/validate.ts";
import { Limiter, type HttpOptions } from "./http.ts";
import { effectiveTable, emptyTable, pricingConfig, type PriceTable } from "./pricing.ts";
import type { ProviderAdapter } from "./types.ts";

/**
 * Adapters register by `$tag`, like entry types do. A provider in `harness.yml` names its
 * adapter with `$tag` (or `!tag`); the adapter's own schema validates the rest; the loader builds it after resolving
 * the secrets it names. The schemas are JSON Schema (TypeBox builds them), which is also what the editor is given: an adapter
 * hands over its schemas and the registry runs them.
 */

/**
 * How tool definitions must be written for the model to see and fill them properly. `full`: any
 * JSON Schema in the portable subset, nested objects and lists of objects included. `flat`: the model is shown only a
 * tool's top-level properties with their types and descriptions (some servers, such as Ollama for gpt-oss, print a list as
 * `any[]` and an object as `Record<string, any>`), so a tool must have scalar properties only. Reserved, not built: `text`
 * (calls written as text for models with no native tool calling) and `raw` (one unescaped text argument).
 */
export const TOOL_CONVENTIONS = ["full", "flat"] as const;
export type ToolConvention = (typeof TOOL_CONVENTIONS)[number];

/** How much JSON Schema an endpoint takes for a tool's arguments: `full` (as written) or `portable` (the subset every provider and local grammar compiler takes). */
export const TOOL_SCHEMAS = ["full", "portable"] as const;
export type ToolSchemaLevel = (typeof TOOL_SCHEMAS)[number];

/** Coarse cost of a model relative to the others of its catalog. */
export const COST_TIERS = ["low", "medium", "high"] as const;
export type CostTier = (typeof COST_TIERS)[number];

/** What is known about a model. Unknown fields are unknown; the harness only warns on what it can tell. */
export interface ModelInfo {
  context_window?: number | undefined;
  max_output_tokens?: number | undefined;
  /** One or two sentences for whoever (or whatever) chooses between models: what it is good at. */
  description?: string | undefined;
  /** How much it costs to use relative to the other models of the catalog. Coarse on purpose: prices change, this is pinned in tool definitions. */
  cost_tier?: CostTier | undefined;
  /** Named reasoning levels, each the model settings that produce it (the names mean the same for every provider; the settings are the adapter's). */
  reasoning?: Record<string, Record<string, unknown>> | undefined;
  /** The level used when none is asked for and the model is not the one already in use. Must be a key of `reasoning`. */
  default_reasoning?: string | undefined;
  /** Default `full`. Measured by the `tools-nesting` live check, or set in `harness.yml`. */
  tool_convention?: ToolConvention | undefined;
  /** What the endpoint takes of a tool's JSON Schema. Default: what the adapter says (`ProviderAdapter.toolSchema`), else `portable`. */
  tool_schema?: ToolSchemaLevel | undefined;
}

export interface AdapterDefinition<C extends TSchema = TSchema, S extends TSchema = TSchema> {
  readonly $tag: string;
  /** The provider's keys in `harness.yml`, `$tag` included. Strict: a misspelt key is an error. */
  readonly config: C;
  /** The model settings this adapter accepts (`agent_setup.model.settings`). */
  readonly settings: S;
  /** The names of the environment variables this provider needs. Each must resolve, or `open` fails naming it. */
  secrets(config: StaticDecode<C>): readonly string[];
  create(config: StaticDecode<C>, secrets: { get(name: string): string | undefined }): ProviderAdapter;
  /** The prices this provider is costed under: the bundled table with the config's overrides on top. Without it every price is unknown. */
  prices?(config: StaticDecode<C>): PriceTable;
  /** The models it knows about, with the config's overrides on top. */
  models?(config: StaticDecode<C>): Record<string, ModelInfo>;
}

export function defineAdapter<C extends TSchema, S extends TSchema>(def: AdapterDefinition<C, S>): AdapterDefinition<C, S> {
  return def;
}

export class AdapterRegistry {
  readonly #defs = new Map<string, AdapterDefinition>();

  /** Throws on a duplicate or malformed `$tag`, so that every tag in `harness.yml` names exactly one adapter. */
  register<C extends TSchema, S extends TSchema>(def: AdapterDefinition<C, S>): this {
    if (this.#defs.has(def.$tag)) throw new Error(`an adapter for $tag ${def.$tag} is already registered`);
    if (!/^[a-z][a-z0-9-]*$/.test(def.$tag)) throw new Error(`invalid adapter $tag ${JSON.stringify(def.$tag)}`);
    this.#defs.set(def.$tag, def);
    return this;
  }
  get(tag: string): AdapterDefinition | undefined {
    return this.#defs.get(tag);
  }
  tags(): string[] {
    return [...this.#defs.keys()].sort();
  }
}

// ---- what every HTTP provider config shares -------------------------------------------------------------------------

/** The name of an environment variable. A key pasted here by mistake is refused, never stored. */
export const envName = pattern(
  /^[A-Za-z_][A-Za-z0-9_]*$/,
  "must be the NAME of an environment variable (letters, digits and _), not the key itself",
);

const opt = Type.Optional;
const positive = Type.Integer({ minimum: 1 });
const nonEmpty = Type.String({ minLength: 1 });

/** What `providers.<name>.models.<id>` may say about a model. */
const modelInfoConfig = rules(
  strictObject({
    context_window: opt(positive),
    max_output_tokens: opt(positive),
    tool_convention: opt(Type.Enum(TOOL_CONVENTIONS)),
    tool_schema: opt(Type.Enum(TOOL_SCHEMAS)),
    description: opt(nonEmpty),
    cost_tier: opt(Type.Enum(COST_TIERS)),
    /** Level name (`low`, `high`, `off`, ...) to the settings that produce it, written as the provider's own `settings`. */
    reasoning: opt(record(pattern(/^[a-z][a-z0-9_-]*$/, "lowercase letters, digits, _ and - only"), record(Type.String(), Type.Unknown()))),
    default_reasoning: opt(Type.String()),
  }),
  [
    (m) =>
      m.default_reasoning === undefined || (m.reasoning !== undefined && m.default_reasoning in m.reasoning)
        ? undefined
        : "default_reasoning must be one of the reasoning levels",
  ],
);

const headerName = pattern(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "not a valid header name");

export const commonProviderFields = {
  /** At most this many requests at once for the provider. */
  max_concurrent: opt(positive),
  timeouts: opt(strictObject({ idle_ms: opt(positive), total_ms: opt(positive) })),
  /** Attempts per request, retries included (only before any content has arrived). */
  max_attempts: opt(positive),
  /** Extra request headers. A `null` removes one; for our default `User-Agent` (`chattree/<version>`) the runtime's own is then sent: some providers' terms require a true client identity, so that is the user's call. */
  headers: opt(record(headerName, Type.Union([Type.String(), Type.Null()]))),
  /** The name of a header to send the conversation's stable id in (OpenCode Go wants `x-opencode-session`). */
  session_header: opt(headerName),
  /** Price overrides, or `free: true` for a local server. Without either, a model with no bundled price has an unknown price. */
  pricing: opt(pricingConfig),
  /** What you know about models the adapter does not (context window, maximum output, how tools must be written: `tool_convention` `full` or `flat`). */
  models: opt(record(Type.String(), modelInfoConfig)),
};

export interface CommonProviderConfig {
  pricing?: Static<typeof pricingConfig> | undefined;
  models?: Record<string, ModelInfo> | undefined;
  max_concurrent?: number | undefined;
  timeouts?: { idle_ms?: number | undefined; total_ms?: number | undefined } | undefined;
  max_attempts?: number | undefined;
  headers?: Record<string, string | null> | undefined;
  session_header?: string | undefined;
}

/** The common config as HTTP base options. Keys the config leaves out are left out too, so the HTTP base's own defaults apply. */
export function httpOptionsFor(c: CommonProviderConfig): HttpOptions {
  return {
    ...(c.max_concurrent === undefined ? {} : { limiter: new Limiter(c.max_concurrent) }),
    ...(c.timeouts === undefined
      ? {}
      : {
          timeouts: {
            ...(c.timeouts.idle_ms === undefined ? {} : { idleMs: c.timeouts.idle_ms }),
            ...(c.timeouts.total_ms === undefined ? {} : { totalMs: c.timeouts.total_ms }),
          },
        }),
    ...(c.max_attempts === undefined ? {} : { retry: { maxAttempts: c.max_attempts } }),
    ...(c.headers === undefined ? {} : { headers: c.headers }),
    ...(c.session_header === undefined ? {} : { sessionHeader: c.session_header }),
  };
}

/** For an adapter definition: the bundled table (if any) with this provider's overrides. */
export const pricesFor = (bundled: PriceTable | undefined, c: CommonProviderConfig): PriceTable => effectiveTable(bundled, c.pricing);
/** The bundled catalog with the config's entries on top, field by field: saying only `context_window` for a known model keeps the rest of what is known. */
export const modelsFor = (bundled: Record<string, ModelInfo> | undefined, c: CommonProviderConfig): Record<string, ModelInfo> => {
  const out: Record<string, ModelInfo> = { ...bundled };
  for (const [id, info] of Object.entries(c.models ?? {})) out[id] = { ...out[id], ...info };
  return out;
};

// ---- validating and building ---------------------------------------------------------------------------------------

const where = (name: string, path: readonly (string | number)[]): string => ["providers", name, ...path.map(String)].join(".");

/** Validate every provider against its adapter's schema. The values are the parsed `providers` of the config. */
export async function validateProviders(
  providers: Record<string, { $tag: string }>,
  registry: AdapterRegistry,
): Promise<{ issues: Issue[]; configs: Map<string, { def: AdapterDefinition; config: unknown }> }> {
  const issues: Issue[] = [];
  const configs = new Map<string, { def: AdapterDefinition; config: unknown }>();
  for (const [name, p] of Object.entries(providers)) {
    const def = registry.get(p.$tag);
    if (def === undefined) {
      issues.push({
        path: `providers.${name}.$tag`,
        message: `no adapter for ${JSON.stringify(p.$tag)} (known: ${registry.tags().join(", ") || "none"})`,
      });
      continue;
    }
    const r = safeParse(def.config, p);
    if (!r.ok) for (const i of r.issues) issues.push({ path: where(name, i.path), message: i.message });
    else configs.set(name, { def, config: r.value });
  }
  return { issues, configs };
}

/** What is wrong with a model-settings object for this adapter: one sentence per problem, none when it is fine. */
export function settingsProblems(def: AdapterDefinition, settings: unknown): string[] {
  const r = safeParse(def.settings, settings);
  return r.ok ? [] : r.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`);
}

export class ProviderSetupError extends Error {
  override name = "ProviderSetupError";
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(`provider configuration: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.issues = issues;
  }
}

export interface BuiltProviders {
  adapters: Map<string, ProviderAdapter>;
  /** The effective price table of each provider, by provider name. */
  prices: Map<string, PriceTable>;
  models: Map<string, Record<string, ModelInfo>>;
  /** The resolved secret values (for redaction and scrubbing). Never log these. */
  secretValues: string[];
}

/**
 * Build the adapters. Everything wrong is reported at once: unknown tags, invalid keys, and every environment
 * variable that is not set (naming the provider that needs it).
 */
export async function buildProviders(
  providers: Record<string, { $tag: string }>,
  registry: AdapterRegistry,
  secrets: { get(name: string): Promise<string | undefined> },
): Promise<BuiltProviders> {
  const { issues, configs } = await validateProviders(providers, registry);
  const values = new Map<string, string>();
  for (const [name, { def, config }] of configs) {
    for (const env of def.secrets(config)) {
      if (values.has(env)) continue;
      const v = await secrets.get(env);
      if (v === undefined || v === "")
        issues.push({
          path: `providers.${name}`,
          message: `the environment variable ${env} is not set (and is not in the repository's secrets file)`,
        });
      else values.set(env, v);
    }
  }
  if (issues.length > 0) throw new ProviderSetupError(issues);
  const adapters = new Map<string, ProviderAdapter>();
  const prices = new Map<string, PriceTable>();
  const models = new Map<string, Record<string, ModelInfo>>();
  for (const [name, { def, config }] of configs) {
    adapters.set(name, def.create(config, { get: (n) => values.get(n) }));
    prices.set(name, def.prices?.(config) ?? emptyTable());
    models.set(name, def.models?.(config) ?? {});
  }
  return { adapters, prices, models, secretValues: [...values.values()] };
}
