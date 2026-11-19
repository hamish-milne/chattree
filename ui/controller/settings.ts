/**
 * What the settings sheet needs from the machine: the `harness.yml` form (its value, its schema, the problems in it), the
 * file written back with its comments kept, and the check of a provider (are its keys set, what models does it offer).
 * Plain functions over a conversation and the provider registry, so the controller only decides when to call them.
 */
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { stringify } from "yaml";
import type { Conversation } from "../../harness/conversation.ts";
import { isRepoPath } from "../../harness/instruction-files.ts";
import { configJsonSchema } from "../../harness/config-schema.ts";
import { harnessConfig } from "../../harness/config.ts";
import { validateProviders, type AdapterRegistry } from "../../providers/registry.ts";
import { editConfig, parseConfig } from "../../src/config.ts";
import { safeParse } from "../../src/validate.ts";
import type { FormIssue, FormSpec } from "../model/form.ts";
import type { InstructionState, ModelInfo, ProviderModels, ProviderStatus } from "../model/settings.ts";

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);

export const HARNESS_FORM = "harness";
const dec = new TextDecoder();

/** The schema as the view receives it: plain JSON. */
export const harnessSchemaOf = (registry: AdapterRegistry): Json => {
  const plain: unknown = JSON.parse(JSON.stringify(configJsonSchema(registry)));
  return isObject(plain) ? plain : {};
};

/** The file as it is now: its text and the plain value of it (empty when there is none or it does not parse). */
export async function readHarness(convo: Conversation): Promise<{ text: string; value: Json; issues: FormIssue[] }> {
  const path = convo.host.path.join(convo.dir, "harness.yml");
  if ((await convo.host.fs.stat(path)) === undefined) return { text: "", value: {}, issues: [] };
  const text = dec.decode(await convo.host.fs.read(path));
  const r = await parseConfig(text, Type.Record(Type.String(), Type.Unknown()));
  return r.ok ? { text, value: r.value, issues: [] } : { text, value: {}, issues: r.issues };
}

/** What is wrong with a value as a `harness.yml`: the core schema, then each provider against its adapter's. */
export async function checkHarness(value: Json, registry: AdapterRegistry): Promise<FormIssue[]> {
  const r = await parseConfig(stringify(value), harnessConfig);
  if (!r.ok) return r.issues.map((i) => ({ path: i.path, message: i.message }));
  const { issues } = await validateProviders(r.value.providers, registry);
  return issues.map((i) => ({ path: i.path, message: i.message }));
}

export function harnessForm(registry: AdapterRegistry, saved: Json, working: Json, issues: FormIssue[]): FormSpec {
  return {
    id: HARNESS_FORM,
    title: "harness.yml",
    schema: harnessSchemaOf(registry),
    value: working,
    issues,
    dirty: !isDeepStrictEqual(saved, working),
    saveLabel: "Save and commit",
  };
}

/**
 * The text of the file with `next` in it. Only the top-level keys that differ from `saved` are touched, so the comments
 * and layout of the rest stay as the person wrote them.
 */
export async function withValue(
  text: string,
  saved: Json,
  next: Json,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const r = await editConfig(text === "" ? "{}\n" : text, harnessConfig, (doc) => {
    for (const key of new Set([...Object.keys(saved), ...Object.keys(next)])) {
      if (isDeepStrictEqual(saved[key], next[key])) continue;
      if (next[key] === undefined) doc.delete(key);
      else doc.set(key, doc.createNode(next[key]));
    }
  });
  return r.ok
    ? { ok: true, text: r.text }
    : { ok: false, message: r.issues.map((i) => `${i.path === "" ? "" : `${i.path}: `}${i.message}`).join("; ") };
}

// ---- providers -------------------------------------------------------------------------------------------------

const providerOf = (value: Json, name: string): unknown => (isObject(value["providers"]) ? value["providers"][name] : undefined);

const asNumber = (x: unknown): number | undefined => (typeof x === "number" ? x : undefined);

/** The models the adapter knows, with what the config says about them, in the sheet's terms. */
function knownModels(def: ReturnType<AdapterRegistry["get"]>, config: unknown): ModelInfo[] {
  if (def === undefined) return [];
  const table = def.prices?.(config);
  return Object.entries(def.models?.(config) ?? {}).map(([id, m]) => {
    const rates = table?.models[id]?.rates?.["standard"];
    const input = asNumber(rates?.input);
    const output = asNumber(rates?.output);
    return {
      id,
      ...(m.context_window === undefined ? {} : { context: m.context_window }),
      ...(input === undefined ? {} : { input_usd: input }),
      ...(output === undefined ? {} : { output_usd: output }),
      ...(m.reasoning === undefined ? {} : { reasoning: Object.keys(m.reasoning).length > 0 }),
    };
  });
}

export interface ProviderCheck {
  status: ProviderStatus;
  list: ProviderModels;
}

/**
 * Try a provider as it is in the file being edited. The keys must be set in the environment; a server that has an address
 * of its own (an OpenAI-compatible one) is asked for its model list, which is a request that needs no model and costs
 * nothing. Never throws: what went wrong is the answer.
 */
export async function checkProvider(
  name: string,
  value: Json,
  o: { registry: AdapterRegistry; env: Readonly<Record<string, string | undefined>>; fetch: typeof fetch; now: () => number },
): Promise<ProviderCheck> {
  const raw = providerOf(value, name);
  const fail = (error: string): ProviderCheck => ({ status: { state: "error", detail: error }, list: { models: [], error } });
  if (!isObject(raw) || typeof raw["$tag"] !== "string") return fail(`there is no provider ${name} in the file`);
  const { issues, configs } = await validateProviders({ [name]: { ...raw, $tag: raw["$tag"] } }, o.registry);
  const found = configs.get(name);
  if (found === undefined) return fail(issues.map((i) => i.message).join("; "));
  const missing = found.def.secrets(found.config).filter((k) => (o.env[k] ?? "") === "");
  if (missing.length > 0) return fail(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set in the environment`);
  const started = o.now();
  const known = knownModels(found.def, found.config);
  const base = raw["base_url"];
  if (raw["$tag"] !== "openai-compatible" || typeof base !== "string") {
    return {
      status: { state: "ok", detail: `${known.length} ${known.length === 1 ? "model" : "models"}`, ms: o.now() - started },
      list: { models: known },
    };
  }
  const keyName = raw["api_key_env"];
  const key = typeof keyName === "string" ? o.env[keyName] : undefined;
  try {
    const res = await o.fetch(`${base.replace(/\/+$/, "")}/models`, {
      headers: key === undefined || key === "" ? {} : { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return fail(`${base} answered ${res.status} ${res.statusText}`.trim());
    const body: unknown = await res.json();
    const data = isObject(body) && Array.isArray(body["data"]) ? body["data"] : [];
    const ids = data.flatMap((d) => (isObject(d) && typeof d["id"] === "string" ? [d["id"]] : []));
    const byId = new Map(known.map((m) => [m.id, m]));
    const models = ids.map((id) => byId.get(id) ?? { id });
    return {
      status: { state: "ok", detail: `${models.length} ${models.length === 1 ? "model" : "models"}`, ms: o.now() - started },
      list: { models },
    };
  } catch (e) {
    return fail(`could not reach ${base}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---- instruction files -----------------------------------------------------------------------------------------

/** Files a workspace commonly has for the agent; the sheet offers the ones that exist and the thread does not have yet. */
const WELL_KNOWN = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
  "CONVENTIONS.md",
  "CONTRIBUTING.md",
];

/**
 * The thread's instruction files as the sheet shows them: those the transcript has (on), those the person turned off in this
 * session (listed so they can be turned on again; the transcript only knows the files that are on), and well-known files found.
 */
export async function instructionState(convo: Conversation, off: ReadonlySet<string>): Promise<InstructionState> {
  const { files } = await convo.setup();
  const stat = async (path: string): Promise<number | undefined> => {
    if (!isRepoPath(path)) return (await convo.store.get(files[path] ?? ""))?.length;
    const abs = convo.host.path.join(convo.dir, ...path.split("/"));
    return (await convo.host.fs.stat(abs))?.size;
  };
  const rows: InstructionState["files"] = [];
  for (const path of Object.keys(files).sort()) {
    const bytes = await stat(path);
    rows.push({ path, on: true, exists: bytes !== undefined, ...(bytes === undefined ? {} : { bytes }) });
  }
  for (const path of [...off].sort()) {
    if (path in files) continue;
    const bytes = await stat(path);
    rows.push({ path, on: false, exists: bytes !== undefined, ...(bytes === undefined ? {} : { bytes }) });
  }
  const found: InstructionState["found"] = [];
  for (const path of WELL_KNOWN) {
    if (rows.some((r) => r.path === path)) continue;
    const bytes = await stat(path);
    if (bytes !== undefined) found.push({ path, bytes });
  }
  return { files: rows, found };
}

// ---- the thread's model ----------------------------------------------------------------------------------------

export const MODEL_FORM = "model-settings";

/** The adapter and the provider's tag for the thread's model, as harness.yml names them; undefined when there is no model or no provider. */
export async function modelAdapter(convo: Conversation, registry: AdapterRegistry) {
  const model = (await convo.setup()).model;
  const cfg = await convo.readConfig();
  if (model === undefined || cfg === undefined || !cfg.ok) return undefined;
  const tag = cfg.value.providers[model.provider]?.$tag;
  const def = tag === undefined ? undefined : registry.get(tag);
  return def === undefined ? undefined : { model, def, tag: def.$tag };
}

/** What is wrong with a model-settings object, by the adapter's own rules. */
export function settingsIssues(def: NonNullable<Awaited<ReturnType<typeof modelAdapter>>>["def"], value: Json): FormIssue[] {
  const r = safeParse(def.settings, value);
  return r.ok ? [] : r.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

export function modelForm(schema: Json, saved: Json, working: Json, issues: FormIssue[]): FormSpec {
  return {
    id: MODEL_FORM,
    title: "Model settings",
    schema,
    value: working,
    issues,
    dirty: !isDeepStrictEqual(saved, working),
    saveLabel: "Apply to thread",
  };
}

export const plainSchema = (schema: unknown): Json => {
  const plain: unknown = JSON.parse(JSON.stringify(schema));
  return isObject(plain) ? plain : {};
};
