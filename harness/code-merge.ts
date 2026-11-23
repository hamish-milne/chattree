/**
 * What a merge does to the code in attached repositories (ADR 38): the plan made before anything is written, the checkouts put as it
 * decided, and the check a subagent makes before handing back. These work on a narrow view of the conversation, so they do not need
 * the class; they throw `AttachedError` and `Conversation` turns that into its own error.
 */
import type { DecodeResult, Git, Host, Identity, TreeEdit } from "../src/index.ts";
import {
  ATTACHED_FILE,
  CODE_DEFAULTS,
  assessCode,
  attachedAtRev,
  codeFacts,
  codeProblem,
  formatAttached,
  gitlinksAt,
  mayHaveAttached,
  recordedAttached,
  restoreAttached,
  type AttachedState,
  type CodeSettings,
  type RestoreResult,
} from "./attached.ts";
import type { CodePlan, CodeResult } from "./conversation-types.ts";
import type { ChatEntry } from "./entries.ts";
import type { HarnessConfig } from "./config.ts";
import type { ConfigResult } from "../src/config.ts";

/** What the code merge needs from the conversation it is working for. */
export interface CodeMergeContext {
  readonly host: Host;
  readonly git: Git;
  readonly dir: string;
  readonly branch: string;
  readonly committer: Identity;
  /** The fixed date for commits, when tests pin one. */
  readonly date: string | undefined;
  readEntries(): Promise<DecodeResult<ChatEntry>[]>;
  readEntriesAt(rev: string): Promise<DecodeResult<ChatEntry>[]>;
  readConfig(): Promise<ConfigResult<HarnessConfig> | undefined>;
  snapshot(): Promise<unknown>;
}

/** The `integrate` a thread was started with (the last `branch_start` of its transcript says). */
export async function integrateOf(ctx: CodeMergeContext, rev: string): Promise<"share" | "thread" | "parent" | undefined> {
  const entries = (await ctx.readEntriesAt(rev)).flatMap((e) => (e.ok ? [e.value] : []));
  const start = entries.findLast((e) => e.$tag === "branch_start");
  return start?.$tag === "branch_start" ? start.integrate : undefined;
}

export async function codeSettings(ctx: CodeMergeContext): Promise<CodeSettings> {
  const cfg = await ctx.readConfig();
  if (cfg?.ok !== true) return CODE_DEFAULTS;
  const a = cfg.value.attached;
  return { state: a.merge.state, rebase: a.merge.rebase, prefix: a.branch_prefix };
}

/**
 * Decide what a merge does to the code in attached repositories (ADR 38) before anything is written: the commit's tree gets the
 * record and the gitlinks the decision implies (a plain tree merge would take the child's commit as if it were a file), and the
 * entry gets a note. A thread whose code cannot be merged stops the merge with a message that says how to put it right.
 */
export async function planCode(
  ctx: CodeMergeContext,
  childBranch: string,
  head: string,
  tip: string,
  base: string,
): Promise<CodePlan | undefined> {
  const [links, theirLinks] = [await gitlinksAt(ctx.git, head), await gitlinksAt(ctx.git, tip)];
  const [ours, theirs, before] = [
    await attachedAtRev(ctx.git, head),
    await attachedAtRev(ctx.git, tip),
    await attachedAtRev(ctx.git, base),
  ];
  // Neither side has anything attached (a gitlink, or a repository linked in from elsewhere): the merge is of files only.
  if (links.length + theirLinks.length + ours.length + theirs.length === 0) return undefined;
  const settings = await codeSettings(ctx);
  const integrate = await integrateOf(ctx, tip);
  const theirTree = (await ctx.git.worktrees()).find((w) => w.branch === `refs/heads/${childBranch}`)?.path ?? ctx.dir;
  const committer = ctx.committer;
  const edits: TreeEdit[] = [...new Set([...links, ...theirLinks])].map((path) => ({ path, from: head }));
  const states = [...ours];
  const results: CodeResult[] = [];
  const apply: AttachedState[] = [];
  for (const t of theirs) {
    const o = ours.find((x) => x.path === t.path);
    const b = before.find((x) => x.path === t.path);
    if (o === undefined || b === undefined) continue;
    let outcome;
    outcome = await assessCode(
      ctx.host,
      ctx.git.withCwd(ctx.host.path.join(ctx.dir, t.path)),
      {
        path: t.path,
        before: b,
        ours: o,
        theirs: t,
        integrate,
        settings,
        ourThread: ctx.branch,
        theirThread: childBranch,
        ourDir: ctx.host.path.join(ctx.dir, t.path),
        theirDir: ctx.host.path.join(theirTree, t.path),
      },
      committer,
      ctx.date,
    );
    const at = states.findIndex((x) => x.path === t.path);
    if (outcome.kind === "state") {
      states[at] = outcome.state;
      apply.push(outcome.state);
      results.push({ path: t.path, outcome: "merged_state", note: outcome.note });
    } else if (outcome.kind === "fast_forward") {
      const { snapshot: _s, ...rest } = o;
      const moved = { ...rest, base: outcome.to };
      states[at] = moved;
      apply.push(moved);
      // A linked-in repository has no gitlink to move: the record says where it is.
      if (theirLinks.includes(t.path)) edits.push({ path: t.path, from: tip });
      results.push({ path: t.path, outcome: "fast_forward", note: outcome.note });
    } else if (outcome.kind === "left") {
      results.push({ path: t.path, outcome: "left", branch: outcome.branch, note: outcome.note });
    }
  }
  const data = new TextEncoder().encode(formatAttached(states));
  return { edits: [...edits, ...(states.length === 0 ? [] : [{ path: ATTACHED_FILE, data }])], results, apply };
}

/** Put the receiving thread's checkouts as the merge decided. */
export async function applyCode(ctx: CodeMergeContext, plan: CodePlan): Promise<RestoreResult[]> {
  if (plan.apply.length === 0) return [];
  return restoreAttached(ctx.host, ctx.git, ctx.branch, plan.apply, ctx.committer);
}

/**
 * What stops this thread's code from being merged into the thread it came from, as a message with the commands that put it right
 * (undefined when nothing does). A subagent's `merge` tool asks before handing back, so the subagent can fix its own side: commits
 * together with uncommitted changes, or commits that have to be rebased onto a parent that has moved on and has nothing uncommitted.
 */
export async function codeMergeProblem(ctx: CodeMergeContext): Promise<string | undefined> {
  if (!(await mayHaveAttached(ctx.host, ctx.dir))) return undefined;
  const entries = (await ctx.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  const start = entries.findLast((e) => e.$tag === "branch_start");
  if (start?.$tag !== "branch_start") return undefined;
  await ctx.snapshot();
  const parentBranch = start.from.branch;
  const parentWt = (await ctx.git.worktrees()).find((w) => w.branch === `refs/heads/${parentBranch}`);
  const [head, parentTip] = [await ctx.git.head(), await ctx.git.revParse(`refs/heads/${parentBranch}`)];
  if (parentWt === undefined || head === undefined || parentTip === undefined) return undefined;
  const base = (await ctx.git.mergeBase(head, parentTip)) ?? start.from.commit;
  const [theirs, before, recorded] = [
    (await recordedAttached(ctx.host, ctx.dir)).states,
    await attachedAtRev(ctx.git, base),
    await attachedAtRev(ctx.git, parentTip),
  ];
  const settings = await codeSettings(ctx);
  for (const t of theirs) {
    const b = before.find((x) => x.path === t.path);
    const rec = recorded.find((x) => x.path === t.path);
    if (b === undefined || rec === undefined) continue;
    const parentRepo = ctx.git.withCwd(ctx.host.path.join(parentWt.path, t.path));
    const [live, branch] = [await parentRepo.revParse("HEAD"), await parentRepo.currentBranch()];
    if (live === undefined) continue;
    const ours: AttachedState = { path: t.path, base: live, ...(branch === undefined ? {} : { branch }) };
    const mine = ctx.git.withCwd(ctx.host.path.join(ctx.dir, t.path));
    const clean = (await parentRepo.status()).length === 0;
    const facts = await codeFacts(mine, { before: b, ours, theirs: t });
    const problem = codeProblem(
      facts,
      { path: t.path, before: b, ours, settings, integrate: start.integrate, theirDir: ctx.host.path.join(ctx.dir, t.path) },
      clean,
    );
    if (problem !== undefined) return problem;
  }
  return undefined;
}
