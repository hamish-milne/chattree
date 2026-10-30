import { ChangeNotAllowed } from "../harness/setup.ts";
import { localOwner } from "./owner.ts";
import type { ChangeKind } from "../harness/entries.ts";
import { LimitExceeded } from "../harness/limits.ts";
import { JournalBusy } from "../harness/journal.ts";
import { ThreadBusy } from "../harness/lease.ts";
import { requestStream } from "../harness/turn.ts";
import { runLoop, syncTools, ToolsNotSupported, ToolsOutOfSync, type LoopEvent } from "../harness/loop.ts";
import { summarizeCall } from "./tool-lines.ts";
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
  engine.cleanTurn = false;
  engine.pump()?.release(engine.thread);
  if (engine.takeStopNext()) ac.abort();
  try {
    let drift: ChangeKind[] = [];
    let tools: Awaited<NonNullable<ReturnType<typeof engine.toolset>>> | undefined;
    try {
      tools = await engine.toolset();
    } catch (e) {
      yield failure(e);
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const warnings: string[] = [];
      let model = "";
      if (tools !== undefined) {
        try {
          yield* toolLoop(ctx, tools, { signal: ac.signal, standing: [...engine.standing, ...drift], drift, warnings, setModel: (m) => (model = m), model: () => model });
          return;
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
          if (e instanceof ToolsNotSupported || e instanceof ToolsOutOfSync) {
            yield { type: "error", message: e.message, hint: "the model cannot be given these tools; /model another model, or set tool_convention for it in harness.yml" };
            return;
          }
          yield failure(e);
          return;
        }
      }
      const gen = requestStream(convo, {
        system: engine.system,
        signal: ac.signal,
        owner: localOwner(engine.sessionId),
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
    engine.turnEnded();
    // A job that ended while the turn was finishing was held back (the thread was busy); nothing else would deliver it until the next turn.
    void engine.toolset()?.then((set) => set.jobs.flushIfIdle()).catch(() => undefined);
  }
}

/** One request-and-tools run: the loop's events as outputs. Throws what the loop throws (a refused change, a limit, tools the model cannot take). */
async function* toolLoop(
  ctx: Ctx,
  tools: Awaited<NonNullable<ReturnType<Ctx["engine"]["toolset"]>>>,
  o: { signal: AbortSignal; standing: ChangeKind[]; drift: ChangeKind[]; warnings: string[]; setModel: (m: string) => void; model: () => string },
): AsyncGenerator<Output, void> {
  const { engine, convo } = ctx;
  await syncTools(convo, tools.registry);
  engine.pump(); // questions and subagents are the pump's, which looks at every thread when this turn ends
  const loop = runLoop(convo, {
    system: engine.system,
    registry: tools.registry,
    jobs: tools.jobs,
    grants: convo.grantStore(),
    // A call no grant covers is not asked here: the loop stops and the question waits with the others, wherever it came from.
    waitForApproval: true,
    signal: o.signal,
    owner: localOwner(engine.sessionId),
    standing: o.standing,
    allowDrift: o.drift,
    onPrepared: (p) => {
      o.setModel(p.setup.model?.id ?? "");
      for (const w of p.warnings) o.warnings.push(w.message);
    },
  });
  let startPending = false;
  for (;;) {
    const n = await loop.next();
    for (const w of o.warnings.splice(0)) yield { type: "warning", message: w };
    if (n.done) {
      const r = n.value;
      if (r.status === "completed" || r.status === "finished" || r.status === "needs_approval" || r.status === "blocked") engine.cleanTurn = true;
      if (r.status === "stopped") yield { type: "notice", message: "stopped; the calls that had not run were answered as not run" };
      else if (r.status === "deadline") yield { type: "notice", message: "the turn's time limit passed; the calls that had not run were answered as not run" };
      else if (r.status === "needs_approval") yield { type: "notice", message: "waiting for your answer" };
      else if (r.status === "blocked") yield { type: "notice", message: `waiting for ${r.blocked?.on ?? "another thread"}; this thread carries on when it is done` };
      return;
    }
    const e = n.value;
    if (startPending && (e.type === "stream" || e.type === "request.end")) {
      startPending = false;
      yield { type: "request_start", model: o.model() };
    }
    const out = await mapLoopEvent(convo, e, () => (startPending = true));
    for (const x of out) yield x;
  }
}

async function mapLoopEvent(convo: Ctx["convo"], e: LoopEvent, started: () => void): Promise<Output[]> {
  switch (e.type) {
    case "request.start":
      started();
      return [];
    case "stream": {
      const m = mapEvent(e.event);
      return m === undefined ? [] : [m];
    }
    case "request.end": {
      const r = e.result;
      const ledger = await convo.ledger().catch(() => undefined);
      const usage = r.status === "completed" ? r.completed.usage : undefined;
      const out: Output[] = [
        {
          type: "request_end",
          status: r.status,
          ...(usage === undefined ? {} : { usage: { input: usage.input_tokens, output: usage.output_tokens, cached: usage.cache_read_tokens ?? 0 } }),
          ...(ledger === undefined ? {} : { turnUsd: ledger.turn.usd, threadUsd: ledger.conversation.usd, unpriced: ledger.conversation.unpriced > 0 }),
          ...(r.status === "completed" ? { stopReason: r.completed.stop_reason } : {}),
        },
      ];
      if (r.status === "interrupted") out.push({ type: "notice", message: r.by === "user" ? "stopped; what arrived is saved (/continue asks the model to carry on)" : "the reply was cut short; what arrived is saved (/continue asks the model to carry on)" });
      return out;
    }
    case "tool.start":
      return [{ type: "tool_start", callId: e.callId, name: e.name, summary: summarizeCall(e.name, e.args) }];
    case "tool.approval": {
      const out: Output[] = [];
      if (e.granted !== undefined) out.push({ type: "notice", message: `allowed until ${e.granted.until}: ${e.granted.keys.join("; ")}` });
      if (e.grantError !== undefined) out.push({ type: "warning", message: `the call was allowed once, but the grant was not saved: ${e.grantError}` });
      return out;
    }
    case "tool.result":
      return [{ type: "tool_result", callId: e.callId, name: e.name, is_error: e.is_error, content: e.content, ms: e.ms, truncated: e.truncated }];
    case "job.event":
      return [{ type: "job_event", job: e.job, status: e.status, summary: e.summary }];
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
  if (e instanceof ThreadBusy) return { type: "error", message: e.message, hint: "wait for it to finish, or stop it there; a lease left by a process that died is taken over by itself" };
  if (e instanceof JournalBusy) return { type: "error", message: e.message, hint: "/abort stops the request that is running" };
  if (e instanceof ProviderError) return { type: "error", message: `the provider failed (${e.kind}${e.status === undefined ? "" : ` ${e.status}`}): ${e.message}`, hint: "nothing was added to the transcript for this attempt; /retry asks again" };
  if (e instanceof CliError) return { type: "error", message: e.message, ...(e.hint === undefined ? {} : { hint: e.hint }) };
  return { type: "error", message: e instanceof Error ? e.message : String(e) };
}
