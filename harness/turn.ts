import type { Conversation } from "./conversation.ts";
import type { Appended } from "./conversation.ts";
import { prepareContext, type PrepareOptions, type Prepared } from "./request.ts";
import { Journal, RequestSuperseded, type JournalOptions } from "./journal.ts";
import { StreamAccumulator } from "./partial.ts";
import { assistantFromCompleted, toEntryBlocks } from "./blocks.ts";
import { usageRecord } from "./ledger.ts";
import { servedModelId, stable } from "./setup.ts";
import { sha256Hex } from "../src/blobs.ts";
import { ProviderError, type Completed, type StreamEvent } from "../providers/types.ts";

/**
 * One request to a model, from the transcript to the transcript (docs/providers.md, P5): check and build the
 * context (`prepareContext`), stream the provider's events to the caller while journaling them beside the
 * repository, and commit the result: the `assistant` entry when the response completes, or an `interrupted` entry
 * holding what arrived when it does not. The loop around it (running tools, asking again) is the caller's.
 */
export interface TurnOptions extends PrepareOptions {
  /** Aborting it stops the request; what had arrived is recorded as `interrupted` with `by: user`. */
  signal?: AbortSignal;
  /**
   * When the turn must be over, as the host's clock reads (`Date.now()` units). Past it the request is stopped and
   * recorded as `interrupted` with `by: error`. Default: `limits.max_turn_seconds` from `harness.yml`, counted from now.
   * A loop that makes several requests in one turn passes the same deadline to each.
   */
  deadline?: number;
  /** The crash journal. `false` runs without one (a failed process then loses the response). */
  journal?: JournalOptions | false;
  /** Who is running this request, written into the journal so that another process can say so (and ask for it to be aborted). */
  owner?: { pid?: number; host?: string; session?: string };
  /** How often to look for an abort request from another process. Default 250 ms. */
  abortPollMs?: number;
  /** Called with what was checked, before anything is sent: the host's chance to show warnings. */
  onPrepared?: (prepared: Prepared) => void | Promise<void>;
}

export type TurnResult =
  /** The response is committed (with the `agent_setup` entry that records a model the provider changed, if any). */
  | { status: "completed"; entries: Appended[]; completed: Completed; prepared: Prepared }
  /** The request ended early and what arrived is committed. `error` is why, unless the user stopped it. */
  | { status: "interrupted"; by: "user" | "error"; entry: Appended; error?: unknown; prepared: Prepared }
  /** The user stopped it before anything arrived; there is nothing to record. */
  | { status: "cancelled"; prepared: Prepared };

const enc = new TextEncoder();

/**
 * Run one request and yield its events. Stopping the iteration early (`return()`, or leaving a `for await`) counts as
 * the user stopping the request. Throws what `prepareContext` throws (nothing has been sent or journaled then),
 * `JournalBusy` if another request is in flight on this branch, and the provider's error when it failed before
 * anything worth recording arrived (the transcript is left as it was, so asking again is safe).
 */
export async function* requestStream(convo: Conversation, opts: TurnOptions): AsyncGenerator<StreamEvent, TurnResult, void> {
  const prepared = await prepareContext(convo, opts);
  await opts.onPrepared?.(prepared);
  const { setup, context } = prepared;
  const model = setup.model;
  if (model === undefined) throw new Error("this agent has no model");
  const adapter = convo.provider(model.provider);
  const now = convo.now;

  let deadline = opts.deadline;
  if (deadline === undefined) {
    const config = await convo.readConfig();
    const secs = config?.ok === true ? config.value.limits.max_turn_seconds : undefined;
    if (secs !== undefined) deadline = now() + secs * 1000;
  }

  let journal: Journal | undefined;
  if (opts.journal !== false) {
    const tip = (await convo.index()).at(-1);
    journal = await Journal.begin(
      convo.host,
      await convo.journalPath(),
      {
        provider: model.provider,
        model: servedModelId(model),
        setup_digest: await sha256Hex(enc.encode(stable(setup))),
        context_digest: await sha256Hex(enc.encode(stable(context))),
        after: tip?.id,
        at: now(),
        ...(opts.owner === undefined ? {} : { owner: opts.owner }),
      },
      { ...opts.journal, now },
      convo.journalStaleMs,
    );
  }

  const controller = new AbortController();
  let stopped: "user" | "deadline" | undefined;
  const stop = (why: "user" | "deadline"): void => {
    stopped ??= why;
    controller.abort();
  };
  const onAbort = (): void => stop("user");
  if (opts.signal?.aborted === true) stop("user");
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (deadline !== undefined) {
    const ms = deadline - now();
    if (ms <= 0) stop("deadline");
    else {
      timer = setTimeout(() => stop("deadline"), ms); // not unref'd: a deadline must fire even if nothing else is keeping the process alive
    }
  }

  // Another process can ask for an abort by leaving a marker beside the journal (`Conversation.requestAbort`).
  let polling = false;
  const poll = journal === undefined ? undefined : setInterval(() => {
    if (polling) return;
    polling = true;
    void journal.abortRequested().then((yes) => { if (yes) stop("user"); }).finally(() => { polling = false; });
  }, opts.abortPollMs ?? 250);

  const acc = new StreamAccumulator();
  const gen = adapter.stream({ context, setup, signal: controller.signal, session: (await sha256Hex(enc.encode(`${convo.dir}\n${convo.branch}`))).slice(0, 32) });
  let completed: Completed | undefined;
  let failure: unknown;
  let finished = false;
  // Under the branch lock, right before the commit: if another process took this request for dead and recovered its
  // journal, the transcript already has the outcome, and writing a second one would leave the request recorded twice.
  const guard = async (): Promise<void> => {
    if (journal !== undefined && !(await journal.owned())) throw new RequestSuperseded(completed);
  };
  const settle = async (): Promise<TurnResult> => {
    try {
      if (completed !== undefined) {
        journal?.write({ t: "done", completed });
        await journal?.flush();
        const entries = await convo.appendResponse({ ...assistantFromCompleted(model.provider, servedModelId(model), completed), ...(prepared.tip === undefined ? {} : { context_tip: prepared.tip }) }, { model: completed.observed.model ?? servedModelId(model) }, guard);
        await journal?.discard();
        return { status: "completed", entries, completed, prepared };
      }
      const user = stopped === "user";
      if (!acc.hasContent) {
        await journal?.discard();
        if (user) return { status: "cancelled", prepared };
        throw stopped === "deadline" ? new ProviderError({ kind: "timeout", message: "the turn's time limit passed before anything arrived" }) : failure;
      }
      const error = user ? undefined : stopped === "deadline" ? "the turn's time limit passed" : failure instanceof Error ? failure.message : "the response ended early";
      const entry = await convo.interrupt({
        guard,
        by: user ? "user" : "error",
        partial: toEntryBlocks(acc.blocks()),
        ...(error === undefined ? {} : { error }),
        ...(acc.usage === undefined ? {} : { usage: usageRecord(acc.usage) }),
      });
      await journal?.discard();
      return { status: "interrupted", by: user ? "user" : "error", entry, ...(user ? {} : { error: failure ?? new ProviderError({ kind: "timeout", message: error as string }) }), prepared };
    } catch (e) {
      await journal?.abandon(); // the commit failed: the journal is what recovery will use (a file that is no longer ours is left alone)
      throw e;
    }
  };

  try {
    while (true) {
      const r = await gen.next();
      if (r.done) {
        completed = r.value;
        break;
      }
      acc.add(r.value);
      journal?.write({ t: "event", e: r.value });
      yield r.value;
    }
  } catch (e) {
    failure = e;
  } finally {
    finished = completed !== undefined || failure !== undefined;
    if (!finished) stop("user"); // the consumer stopped iterating
    if (timer !== undefined) clearTimeout(timer);
    if (poll !== undefined) clearInterval(poll);
    opts.signal?.removeEventListener("abort", onAbort);
    if (!finished) {
      await gen.return(undefined as never).catch(() => undefined);
      await settle(); // iteration was stopped from outside: record what arrived (the caller never sees this result)
    }
  }
  return settle();
}


/** `requestStream`, drained: `onEvent` sees each event (awaited, so it can apply backpressure), the result says how it ended. */
export async function runRequest(convo: Conversation, opts: TurnOptions & { onEvent?: (event: StreamEvent) => void | Promise<void> }): Promise<TurnResult> {
  const gen = requestStream(convo, opts);
  while (true) {
    const r = await gen.next();
    if (r.done) return r.value;
    await opts.onEvent?.(r.value);
  }
}
