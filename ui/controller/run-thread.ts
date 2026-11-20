import { localOwner } from "../../app/owner.ts";
import { mediaFor, type ToolSet } from "../../app/toolset.ts";
import type { AppEnv } from "../../app/env.ts";
import type { Conversation } from "../../harness/conversation.ts";
import { SYSTEM_PROMPT, type HostEnvironment } from "../../harness/environment.ts";
import { unanswered } from "../../harness/tip.ts";
import { runLoop, syncTools, toolDrift, type Approval, type ApprovalRequest, type LoopEvent, type LoopResult } from "../../harness/loop.ts";

export interface RunOptions {
  env: AppEnv;
  convo: Conversation;
  tools: ToolSet;
  /** Names this session as the holder of the thread's run lease. */
  session: string;
  signal: AbortSignal;
  environment?: HostEnvironment | undefined;
  /** Asked about a call no grant covers. */
  approve(request: ApprovalRequest): Promise<Approval>;
  /** Called once the request is ready to send, with the setup and environment notes committed, before the model is waited on. */
  onPrepared?(): void | Promise<void>;
  /** Told about everything the loop does, in order; the loop waits for it. */
  onEvent(event: LoopEvent): void | Promise<void>;
}

const drifted = (d: Awaited<ReturnType<typeof toolDrift>>): boolean => d.missing.length + d.changed.length + d.extra.length > 0;

/**
 * Run the model on a thread until it has answered, with its tools, calling `onEvent` for what happens. A call no grant covers
 * is asked about through `approve` while the loop waits. What the loop refuses (a limit, a changed price, a thread another
 * process is running) is thrown for the caller to explain.
 */
export async function runThread(o: RunOptions): Promise<LoopResult> {
  // A thread in the middle of a tool loop cannot have its tools changed. One the pump started (a fork) is pinned to the leaf tools, so
  // it goes on with those, and is brought up to date at its next request after the loop.
  let registry = o.tools.registry;
  const entries = (await o.convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  if (unanswered(entries).length === 0) await syncTools(o.convo, registry);
  else if (drifted(await toolDrift(o.convo, registry)) && !drifted(await toolDrift(o.convo, o.tools.childRegistry)))
    registry = o.tools.childRegistry;
  const loop = runLoop(o.convo, {
    system: SYSTEM_PROMPT,
    environment: o.environment,
    registry,
    jobs: o.tools.jobs,
    grants: o.convo.grantStore(),
    approve: (r) => o.approve(r),
    signal: o.signal,
    owner: localOwner(o.session),
    media: mediaFor(o.env, () => o.convo.git.commonDir()),
    onPrepared: () => o.onPrepared?.(),
  });
  for (;;) {
    const n = await loop.next();
    if (n.done) return n.value;
    await o.onEvent(n.value);
  }
}
