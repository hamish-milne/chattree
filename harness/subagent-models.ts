import type { ModelInfo } from "../providers/registry.ts";
import type { ModelSetup } from "./setup.ts";

/**
 * Which models a parent may give a subagent, and how a choice becomes the child's model setting (docs/tools.md, 4.2). The list is
 * `subagent.models` in harness.yml; what each model is good at, what it costs and its reasoning levels come from the provider's
 * catalog (`ModelInfo`). Reasoning levels have the same names for every provider and the catalog maps each to the settings that produce
 * it, so the parent says `reasoning: "low"` and never needs to know the adapter's own words.
 */

export interface SubagentModel {
  /** `provider/model`, the name the parent uses and the approval keys are built from. */
  key: string;
  provider: string;
  id: string;
  description?: string;
  costTier?: string;
  contextWindow?: number;
  /** The levels the parent may ask for, each with the model settings that produce it. */
  levels: Record<string, Record<string, unknown>>;
  /** Used when the model is not the one already in use and no level is asked for. */
  defaultLevel?: string;
  info: ModelInfo;
}

export type ListedModels = Record<string, { description?: string | undefined; reasoning?: string[] | undefined }>;

/**
 * The configured list resolved against the catalog. `lookup` is what the conversation knows of a model. A model the catalog does not
 * know is still allowed (it just has no description and no levels); a provider that is not configured is a problem.
 */
export function resolveSubagentModels(listed: ListedModels | undefined, providers: ReadonlySet<string>, lookup: (provider: string, id: string) => ModelInfo | undefined): { models: SubagentModel[]; problems: string[] } {
  const models: SubagentModel[] = [];
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(listed ?? {})) {
    const slash = key.indexOf("/");
    const provider = key.slice(0, slash);
    const id = key.slice(slash + 1);
    if (!providers.has(provider)) {
      problems.push(`subagent.models: ${key}: there is no provider ${provider} in harness.yml`);
      continue;
    }
    const info = lookup(provider, id) ?? {};
    const all = info.reasoning ?? {};
    const names = entry.reasoning ?? Object.keys(all);
    const levels: Record<string, Record<string, unknown>> = {};
    for (const n of names) {
      const patch = all[n];
      if (patch === undefined) problems.push(`subagent.models: ${key}: the catalog has no reasoning level ${JSON.stringify(n)} for this model (it has: ${Object.keys(all).join(", ") || "none"})`);
      else levels[n] = patch;
    }
    const description = entry.description ?? info.description;
    models.push({
      key,
      provider,
      id,
      ...(description === undefined ? {} : { description }),
      ...(info.cost_tier === undefined ? {} : { costTier: info.cost_tier }),
      ...(info.context_window === undefined ? {} : { contextWindow: info.context_window }),
      levels,
      ...(info.default_reasoning !== undefined && info.default_reasoning in levels ? { defaultLevel: info.default_reasoning } : {}),
      info,
    });
  }
  return { models, problems };
}

const tokens = (n: number): string => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`);

/** The paragraph of the tool description that lists the choices. Nothing in it changes when only prices do: the cost is a tier. */
export function describeModels(models: readonly SubagentModel[]): string {
  if (models.length === 0) return "";
  const lines = models.map((m) => {
    const facts = [
      ...(m.costTier === undefined ? [] : [`cost: ${m.costTier}`]),
      ...(m.contextWindow === undefined ? [] : [`context: ${tokens(m.contextWindow)}`]),
      ...(Object.keys(m.levels).length === 0 ? [] : [`reasoning: ${Object.keys(m.levels).map((l) => (l === m.defaultLevel ? `${l} (default)` : l)).join(", ")}`]),
    ];
    return `- ${m.key}${facts.length === 0 ? "" : ` [${facts.join("; ")}]`}${m.description === undefined ? "" : `: ${m.description}`}`;
  });
  return `\n\nBy default the subagent uses the same model as you. To choose another, pass \`model\`, and \`reasoning\` for how hard it thinks (more costs more and takes longer). A cheaper model is the right choice for simple, well-specified work; the user may be asked to approve a choice. Models:\n${lines.join("\n")}`;
}

/** The `model` and `reasoning` arguments of the tool (nothing when no model is offered). */
export function modelProperties(models: readonly SubagentModel[]): Record<string, unknown> {
  if (models.length === 0) return {};
  const levels = [...new Set(models.flatMap((m) => Object.keys(m.levels)))];
  return {
    model: { type: "string", enum: models.map((m) => m.key), description: "The model for the subagent, as provider/model. Default: your own model." },
    ...(levels.length === 0 ? {} : { reasoning: { type: "string", enum: levels, description: "How hard the subagent thinks. Which levels a model has is in the tool description. Default: the model's usual level." } }),
  };
}

export type ChildModel = { ok: true; model: ModelSetup | undefined; key: string; level: string | undefined } | { ok: false; message: string };

/**
 * The model setting for a child from the call's `model` and `reasoning`. `undefined` means "the same as the parent": the child gets
 * the parent's setup as it is. Otherwise the settings are the level's patch over a base that is the parent's own settings when only the
 * level changes, and just the output cap for another model (the parent's other settings belong to the parent's model).
 */
export function childModel(want: { model?: string | undefined; reasoning?: string | undefined }, models: readonly SubagentModel[], parent: ModelSetup | undefined, parentInfo: ModelInfo | undefined): ChildModel {
  if (want.model === undefined && want.reasoning === undefined) return { ok: true, model: undefined, key: "inherit", level: undefined };
  if (parent === undefined) return { ok: false, message: "there is no model to base the subagent's on: this conversation has no model set" };
  const sameKey = want.model === undefined || want.model === `${parent.provider}/${parent.id}`;
  let levels: Record<string, Record<string, unknown>>;
  let chosen: SubagentModel | undefined;
  if (sameKey) {
    // Another level of the model in use: any level the catalog has for it, whether or not it is in the list.
    chosen = models.find((m) => m.key === `${parent.provider}/${parent.id}`);
    levels = chosen?.levels ?? parentInfo?.reasoning ?? {};
  } else {
    chosen = models.find((m) => m.key === want.model);
    if (chosen === undefined) return { ok: false, message: `${JSON.stringify(want.model)} is not one of the models you may choose: ${models.map((m) => m.key).join(", ") || "none"}` };
    levels = chosen.levels;
  }
  const key = sameKey ? `${parent.provider}/${parent.id}` : (chosen as SubagentModel).key;
  const level = want.reasoning ?? (sameKey ? undefined : chosen?.defaultLevel);
  if (level !== undefined && levels[level] === undefined) {
    return { ok: false, message: `${key} has no reasoning level ${JSON.stringify(level)}${Object.keys(levels).length === 0 ? " (it has none)" : `; its levels are ${Object.keys(levels).join(", ")}`}` };
  }
  if (sameKey) {
    if (level === undefined) return { ok: true, model: undefined, key: "inherit", level: undefined };
    return { ok: true, model: { provider: parent.provider, id: parent.id, settings: { ...((parent.settings as Record<string, unknown> | undefined) ?? {}), ...(levels[level] as Record<string, unknown>) } }, key, level };
  }
  const c = chosen as SubagentModel;
  const parentMax = c.provider === parent.provider ? ((parent.settings as Record<string, unknown> | undefined)?.["max_output_tokens"] as number | undefined) : undefined;
  const cap = c.info.max_output_tokens;
  const max = cap !== undefined && parentMax !== undefined ? Math.min(cap, parentMax) : (cap ?? parentMax);
  if (max === undefined) return { ok: false, message: `the output cap for ${key} is not known: set providers.${c.provider}.models.${c.id}.max_output_tokens in harness.yml` };
  return { ok: true, model: { provider: c.provider, id: c.id, settings: { max_output_tokens: max, ...(level === undefined ? {} : (levels[level] as Record<string, unknown>)) } }, key, level };
}

/** The approval key for a call: `inherit`, or `provider/model@level` (`@default` when the model's usual level is used). */
export function approvalKey(choice: { key: string; level: string | undefined }): string {
  return choice.key === "inherit" ? "inherit" : `${choice.key}@${choice.level ?? "default"}`;
}
