import { ChangeNotAllowed } from "../harness/setup.ts";
import type { ChangeKind } from "../harness/entries.ts";
import { LimitExceeded } from "../harness/limits.ts";
import { JournalBusy } from "../harness/journal.ts";
import { requestStream } from "../harness/turn.ts";
import { ProviderError, type StreamEvent } from "../providers/types.ts";
import { CliError } from "./io.ts";
import type { Ctx } from "./engine.ts";
import type { Output } from "./output.ts";

/**
 * One request to the model for the thread as it stands, shown as it streams. Shared by `/say`, `/retry` and `/continue`.
 * Library refusals become questions or errors here, because deciding what to do about them is the host's job: a changed
 * price table or provider-observed change is shown and, if the user says yes, accepted for this request; a limit is shown with
 * how to move it.
 */
export async function* runTurn(ctx: Ctx): AsyncGenerator<Output, void> {
  const { engine, convo } = ctx;
  const ac = new AbortController();
  engine.abort = ac;
  engine.running = true;
  try {
    let drift: ChangeKind[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const warnings: string[] = [];
      let model = "";
      const gen = requestStream(convo, {
        system: engine.system,
        signal: ac.signal,
        owner: { pid: process.pid, ...(engine.sessionId === undefined ? {} : { session: engine.sessionId }) },
        standing: [...engine.standing, ...drift],
        allowDrift: drift,
        onPrepared: (p) => {
          model = p.setup.model?.id ?? "";
          for (const w of p.warnings) warnings.push(w.message);
        },
      });
      try {
        let started = false;
        while (true) {
          const n = await gen.next();
          for (const w of warnings.splice(0)) yield { type: "warning", message: w };
          if (!started) {
            started = true;
            yield { type: "request_start", model };
          }
          if (n.done) {
            const r = n.value;
            const ledger = await convo.ledger().catch(() => undefined);
            const usage = r.status === "completed" ? r.completed.usage : undefined;
            yield {
              type: "request_end",
              status: r.status,
              ...(usage === undefined ? {} : { usage: { input: usage.input_tokens, output: usage.output_tokens, cached: usage.cache_read_tokens ?? 0 } }),
              ...(ledger === undefined ? {} : { turnUsd: ledger.turn.usd, threadUsd: ledger.conversation.usd, unpriced: ledger.conversation.unpriced > 0 }),
              ...(r.status === "completed" ? { stopReason: r.completed.stop_reason } : {}),
            };
            if (r.status === "completed" && r.completed.stop_reason === "tool_use") yield { type: "notice", message: "the model asked to call a tool, but this version of the CLI has no tool loop yet; the call is in the transcript" };
            if (r.status === "interrupted") yield { type: "notice", message: r.by === "user" ? "stopped; what arrived is saved (/continue asks the model to carry on)" : "the reply was cut short; what arrived is saved (/continue asks the model to carry on)" };
            return;
          }
          const o = mapEvent(n.value);
          if (o !== undefined) yield o;
        }
      } catch (e) {
        if (e instanceof ChangeNotAllowed && attempt < 2) {
          yield { type: "notice", message: e.changes.map((c) => `${c.kind}: ${c.message}`).join("\n") };
          if (!(await ctx.confirm("Go ahead anyway?"))) {
            yield { type: "error", message: "not sent", hint: "nothing was sent; /accept accepts a change the provider made, then /retry asks again" };
            return;
          }
          if (e.allowWith.includes("pricing_changed")) {
            await convo.pinPricing();
            yield { type: "notice", message: "pinned the provider's current prices" };
          }
          drift = [...new Set([...drift, ...e.allowWith.filter((k) => k !== "pricing_changed")])];
          continue;
        }
        yield failure(e);
        return;
      }
    }
  } finally {
    engine.running = false;
    engine.abort = undefined;
  }
}

function mapEvent(e: StreamEvent): Output | undefined {
  if (e.type === "text.delta") return { type: "stream", kind: "text", text: e.text };
  if (e.type === "reasoning.delta") return { type: "stream", kind: "reasoning", text: e.text };
  return undefined;
}

/** A thrown error as something to show, with what to do next. */
export function failure(e: unknown): Output {
  if (e instanceof ChangeNotAllowed) return { type: "error", message: e.message };
  if (e instanceof LimitExceeded) return { type: "error", message: e.message };
  if (e instanceof JournalBusy) return { type: "error", message: e.message, hint: "/abort stops the request that is running" };
  if (e instanceof ProviderError) return { type: "error", message: `the provider failed (${e.kind}${e.status === undefined ? "" : ` ${e.status}`}): ${e.message}`, hint: "nothing was added to the transcript for this attempt; /retry asks again" };
  if (e instanceof CliError) return { type: "error", message: e.message, ...(e.hint === undefined ? {} : { hint: e.hint }) };
  return { type: "error", message: e instanceof Error ? e.message : String(e) };
}
