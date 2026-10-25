import { createHash } from "node:crypto";
import type { Conversation } from "./conversation.ts";
import { buildContext, type ModelContext } from "./context-builder.ts";
import { assertDefinitions, loadDefinitions, type DefinitionSource } from "./definitions.ts";
import type { ChangeKind } from "./entries.ts";
import { DEFAULT_RENDERER, findRenderer, type Renderers } from "./renderer.ts";
import { estimateRequest, type Estimate } from "./estimate.ts";
import { computeLedger, type Ledger } from "./ledger.ts";
import { checkLimits, LimitExceeded, type CostWarning } from "./limits.ts";
import { ChangeNotAllowed, servedModelId, type AgentSetup } from "./setup.ts";
import { tableHash } from "../providers/pricing.ts";

export interface PrepareOptions {
  /** The harness's own prompt. Part of the pinned prefix. */
  system: string;
  /** The host's hook for definitions that are pinned `external`, and for detecting drift in all of them. */
  source?: DefinitionSource;
  /** Change kinds the host accepts without asking, for provider-observed changes (see `Conversation.checkRequest`). */
  standing?: readonly ChangeKind[];
  /** Renderers beyond the built-in ones, by id. The setup's `renderer` must be among them or built in. */
  renderers?: Renderers;
  /** Definition drift the host accepts for this request. */
  allowDrift?: readonly ChangeKind[];
  /**
   * Cost checks run when the conversation was opened with providers: the price table must be the one the agent is
   * pinned to (`pricing_changed` otherwise, accepted with `allowDrift` or by `pinPricing()`), and the request must fit
   * the limits in `harness.yml` (`LimitExceeded` otherwise). `false` turns them off.
   */
  cost?: false;
  /**
   * When to ask the provider to count the request's tokens, where its adapter can: `auto` (the default) only when the
   * byte estimate is near a limit, the context window or a long-context threshold, since only then does the exact
   * figure change a decision; `always`; or `never`. A failed count keeps the estimate and adds a `token_count_failed` warning.
   */
  count?: "auto" | "always" | "never";
}

const counts = new WeakMap<Conversation, Map<string, number>>();

export interface Prepared {
  setup: AgentSetup;
  context: ModelContext;
  /** Present when cost checks ran. */
  estimate?: Estimate;
  ledger?: Ledger;
  /** Things to tell the user before sending: nearing a limit, an unknown price, the context window. */
  warnings: CostWarning[];
}

/**
 * Everything a request needs, checked: the setup (refusing if a provider-observed change is unacknowledged),
 * definitions that still match their pins, and the context built for the model the setup names (the dated model
 * once the provider has reported it). Throws `ChangeNotAllowed` for anything the host has not accepted, and
 * `ConversationError` if the agent has no model yet.
 */
export async function prepareContext(convo: Conversation, opts: PrepareOptions): Promise<Prepared> {
  const setup = await convo.checkRequest(opts.standing);
  if (setup.model === undefined) throw new Error("this agent has no model: set one with setupChange first");
  await assertDefinitions(setup, opts.source, opts.allowDrift);
  const defs = await loadDefinitions(setup, { blobs: convo.store, ...(opts.source === undefined ? {} : { source: opts.source }) });
  const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  const dec = new TextDecoder();
  const renderer = findRenderer(setup.renderer ?? DEFAULT_RENDERER, opts.renderers);
  const context = await buildContext(entries, {
    renderer,
    system: opts.system,
    instructions: defs.instructions,
    tools: defs.tools,
    target: { provider: setup.model.provider, model: servedModelId(setup.model) },
    readText: async (r) => {
      const bytes = await convo.store.get(r.sha256);
      if (bytes === undefined) throw new Error(`blob ${r.sha256} is missing`);
      return dec.decode(bytes);
    },
  });
  if (opts.cost === false || convo.providers.size === 0) return { setup, context, warnings: [] };

  // Prices: the agent's pin must be the provider's current table, or the host must have said it accepts the difference.
  const model = setup.model;
  const current = convo.priceTable(model.provider);
  if (current !== undefined) {
    const pinned = setup.pricing?.table;
    if (pinned !== tableHash(current) && !(opts.allowDrift ?? []).includes("pricing_changed")) {
      throw new ChangeNotAllowed([{ kind: "pricing_changed", message: pinned === undefined ? "no price table is pinned for this agent; pin the current one with pinPricing()" : "the provider's price table is not the one this agent is pinned to; pin the new one with pinPricing()" }]);
    }
  }
  const resolver = convo.priceResolver();
  const pinnedTable = setup.pricing === undefined ? undefined : await resolver.table(setup.pricing.table);
  const config = await convo.readConfig();
  const limits = config?.ok === true ? config.value.limits : {};
  const modelRef = { id: servedModelId(model), settings: model.settings };
  const table = pinnedTable ?? current;
  const info = convo.modelInfo(model.provider, servedModelId(model));
  let estimate = estimateRequest(context, modelRef, table, info);
  const ledger = await computeLedger(entries, resolver);
  let checked = checkLimits({ limits, ledger, estimate });
  const adapter = convo.providers.get(model.provider);
  const mode = opts.count ?? "auto";
  const near = (n: number | undefined): boolean => n !== undefined && estimate.inputTokens >= n * 0.6;
  const matters = checked.violations.length > 0 || checked.warnings.some((w) => w.kind === "near_limit" || w.kind === "context_window" || w.kind === "long_context") || near(estimate.contextWindow) || near(estimate.longContextAt);
  let countFailed: CostWarning | undefined;
  if (adapter?.countTokens !== undefined && mode !== "never" && (mode === "always" || matters)) {
    const key = createHash("sha256").update(JSON.stringify([model.provider, modelRef.id, context])).digest("hex");
    const cache = counts.get(convo) ?? new Map<string, number>();
    counts.set(convo, cache);
    try {
      let n = cache.get(key);
      if (n === undefined) {
        n = await adapter.countTokens({ context, setup, signal: AbortSignal.timeout(15_000) });
        cache.set(key, n);
      }
      estimate = estimateRequest(context, modelRef, table, info, n);
      checked = checkLimits({ limits, ledger, estimate });
    } catch (e) {
      countFailed = { kind: "token_count_failed", message: `could not count the request's tokens (${e instanceof Error ? e.message : String(e)}); using the size estimate, which errs high` };
    }
  }
  const { violations } = checked;
  const warnings = countFailed === undefined ? checked.warnings : [...checked.warnings, countFailed];
  if (violations.length > 0) throw new LimitExceeded(violations);
  return { setup, context, estimate, ledger, warnings };
}
