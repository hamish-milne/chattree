import { localOwner } from "../../app/owner.ts";
import { mediaFor, type ToolSet } from "../../app/toolset.ts";
import type { AppEnv } from "../../app/env.ts";
import type { Conversation } from "../../harness/conversation.ts";
import { SYSTEM_PROMPT, type HostEnvironment } from "../../harness/environment.ts";
import { runLoop, syncTools, type Approval, type ApprovalRequest, type LoopEvent, type LoopResult } from "../../harness/loop.ts";

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

/**
 * Run the model on a thread until it has answered, with its tools, calling `onEvent` for what happens. A call no grant covers
 * is asked about through `approve` while the loop waits. What the loop refuses (a limit, a changed price, a thread another
 * process is running) is thrown for the caller to explain.
 */
export async function runThread(o: RunOptions): Promise<LoopResult> {
  await syncTools(o.convo, o.tools.registry);
  const loop = runLoop(o.convo, {
    system: SYSTEM_PROMPT,
    environment: o.environment,
    registry: o.tools.registry,
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
