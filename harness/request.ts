import type { Conversation } from "./conversation.ts";
import { buildContext, type ModelContext } from "./context-builder.ts";
import { assertDefinitions, loadDefinitions, type DefinitionSource } from "./definitions.ts";
import type { ChangeKind } from "./entries.ts";
import { DEFAULT_RENDERER, findRenderer, type Renderers } from "./renderer.ts";
import { servedModelId, type AgentSetup } from "./setup.ts";

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
}

/**
 * Everything a request needs, checked: the setup (refusing if a provider-observed change is unacknowledged),
 * definitions that still match their pins, and the context built for the model the setup names (the dated model
 * once the provider has reported it). Throws `ChangeNotAllowed` for anything the host has not accepted, and
 * `ConversationError` if the agent has no model yet.
 */
export async function prepareContext(convo: Conversation, opts: PrepareOptions): Promise<{ setup: AgentSetup; context: ModelContext }> {
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
  return { setup, context };
}
