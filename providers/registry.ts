import { z } from "zod";
import type { Issue } from "../src/errors.ts";
import type { StandardSchemaV1 } from "../src/standard-schema.ts";
import { Limiter, type HttpOptions } from "./http.ts";
import type { ProviderAdapter } from "./types.ts";

/**
 * Adapters register by `$tag`, like entry types do (docs/providers.md, P6). A provider in `harness.yml` names its
 * adapter with `$tag` (or `!tag`); the adapter's own schema validates the rest; the loader builds it after resolving
 * the secrets it names. The schemas are Standard Schema, so a third-party adapter is not tied to one library, and
 * each adapter must be able to emit JSON Schema for the editor.
 */

export interface AdapterDefinition<C extends { $tag: string } = { $tag: string }> {
  readonly $tag: string;
  /** The provider's keys in `harness.yml`, `$tag` included. Strict: a misspelt key is an error. */
  readonly config: StandardSchemaV1<unknown, C>;
  /** The model settings this adapter accepts (`agent_setup.model.settings`). */
  readonly settings: StandardSchemaV1;
  jsonSchema(): { config: object; settings: object };
  /** The names of the environment variables this provider needs. Each must resolve, or `open` fails naming it. */
  secrets(config: C): readonly string[];
  create(config: C, secrets: { get(name: string): string | undefined }): ProviderAdapter;
}

export function defineAdapter<C extends { $tag: string }>(def: AdapterDefinition<C>): AdapterDefinition<C> {
  return def;
}

export class AdapterRegistry {
  readonly #defs = new Map<string, AdapterDefinition>();

  register<C extends { $tag: string }>(def: AdapterDefinition<C>): this {
    if (this.#defs.has(def.$tag)) throw new Error(`an adapter for $tag ${def.$tag} is already registered`);
    if (!/^[a-z][a-z0-9-]*$/.test(def.$tag)) throw new Error(`invalid adapter $tag ${JSON.stringify(def.$tag)}`);
    this.#defs.set(def.$tag, def as unknown as AdapterDefinition);
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
export const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be the NAME of an environment variable (letters, digits and _), not the key itself");

export const commonProviderFields = {
  /** At most this many requests at once for the provider. */
  max_concurrent: z.number().int().positive().optional(),
  timeouts: z.strictObject({ idle_ms: z.number().int().positive().optional(), total_ms: z.number().int().positive().optional() }).optional(),
  /** Attempts per request, retries included (only before any content has arrived). */
  max_attempts: z.number().int().positive().optional(),
};

export interface CommonProviderConfig {
  max_concurrent?: number | undefined;
  timeouts?: { idle_ms?: number | undefined; total_ms?: number | undefined } | undefined;
  max_attempts?: number | undefined;
}

export function httpOptionsFor(c: CommonProviderConfig): HttpOptions {
  return {
    ...(c.max_concurrent === undefined ? {} : { limiter: new Limiter(c.max_concurrent) }),
    ...(c.timeouts === undefined ? {} : { timeouts: { ...(c.timeouts.idle_ms === undefined ? {} : { idleMs: c.timeouts.idle_ms }), ...(c.timeouts.total_ms === undefined ? {} : { totalMs: c.timeouts.total_ms }) } }),
    ...(c.max_attempts === undefined ? {} : { retry: { maxAttempts: c.max_attempts } }),
  };
}

// ---- validating and building ---------------------------------------------------------------------------------------

const where = (name: string, path: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined): string => ["providers", name, ...(path ?? []).map((p) => String(typeof p === "object" ? p.key : p))].join(".");

/** Validate every provider against its adapter's schema. The values are the parsed `providers` of the config. */
export async function validateProviders(providers: Record<string, { $tag: string }>, registry: AdapterRegistry): Promise<{ issues: Issue[]; configs: Map<string, { def: AdapterDefinition; config: { $tag: string } }> }> {
  const issues: Issue[] = [];
  const configs = new Map<string, { def: AdapterDefinition; config: { $tag: string } }>();
  for (const [name, p] of Object.entries(providers)) {
    const def = registry.get(p.$tag);
    if (def === undefined) {
      issues.push({ path: `providers.${name}.$tag`, message: `no adapter for ${JSON.stringify(p.$tag)} (known: ${registry.tags().join(", ") || "none"})` });
      continue;
    }
    const r = await def.config["~standard"].validate(p);
    if (r.issues !== undefined) for (const i of r.issues) issues.push({ path: where(name, i.path), message: i.message });
    else configs.set(name, { def, config: r.value as { $tag: string } });
  }
  return { issues, configs };
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
  /** The resolved secret values (for redaction and scrubbing). Never log these. */
  secretValues: string[];
}

/**
 * Build the adapters. Everything wrong is reported at once: unknown tags, invalid keys, and every environment
 * variable that is not set (naming the provider that needs it).
 */
export async function buildProviders(providers: Record<string, { $tag: string }>, registry: AdapterRegistry, secrets: { get(name: string): Promise<string | undefined> }): Promise<BuiltProviders> {
  const { issues, configs } = await validateProviders(providers, registry);
  const values = new Map<string, string>();
  for (const [name, { def, config }] of configs) {
    for (const env of def.secrets(config as never)) {
      if (values.has(env)) continue;
      const v = await secrets.get(env);
      if (v === undefined || v === "") issues.push({ path: `providers.${name}`, message: `the environment variable ${env} is not set (and is not in the repository's secrets file)` });
      else values.set(env, v);
    }
  }
  if (issues.length > 0) throw new ProviderSetupError(issues);
  const adapters = new Map<string, ProviderAdapter>();
  for (const [name, { def, config }] of configs) adapters.set(name, def.create(config as never, { get: (n) => values.get(n) }));
  return { adapters, secretValues: [...values.values()] };
}
