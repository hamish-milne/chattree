import { AppError } from "../../app/errors.ts";
import { CompactionInsufficient, ContextFull } from "../../harness/compaction.ts";
import { JournalBusy } from "../../harness/journal.ts";
import { ThreadBusy } from "../../harness/lease.ts";
import { LimitExceeded } from "../../harness/limits.ts";
import { ToolsNotSupported, ToolsOutOfSync } from "../../harness/loop.ts";
import { ChangeNotAllowed } from "../../harness/setup.ts";
import { ConfigNotTrusted } from "../../harness/trust.ts";
import { ProviderError } from "../../providers/types.ts";

/** A thrown error as a sentence for the person, with what to do about it when that is known. */
export function explain(e: unknown): string {
  const hint = (message: string, h: string): string => `${message} (${h})`;
  if (e instanceof ConfigNotTrusted) return hint(e.message, "review harness.yml in the settings, then approve it");
  if (e instanceof ChangeNotAllowed)
    return hint(e.message, "a change the provider made or a price that moved: check the model in the settings");
  if (e instanceof CompactionInsufficient)
    return hint(e.message, "the thread is kept as it is; send again, or change compaction in harness.yml");
  if (e instanceof ThreadBusy) return hint(e.message, "wait for it to finish, or stop it where it runs");
  if (e instanceof JournalBusy) return hint(e.message, "another window is making a request on this thread");
  if (e instanceof ToolsNotSupported || e instanceof ToolsOutOfSync)
    return hint(e.message, "the model cannot be given these tools: choose another model, or change its tool convention in harness.yml");
  if (e instanceof ProviderError)
    return hint(
      `the provider failed (${e.kind}${e.status === undefined ? "" : ` ${e.status}`}): ${e.message}`,
      "nothing was added for this attempt; use Continue on the thread to try again",
    );
  if (e instanceof ContextFull || e instanceof LimitExceeded) return e.message;
  if (e instanceof AppError) return e.hint === undefined ? e.message : hint(e.message, e.hint);
  return e instanceof Error ? e.message : String(e);
}

/**
 * A thrown error with everything known about it, for the log (the person is shown `explain`): its kind and status, whether it can
 * be retried, and the chain of causes (the provider's own words are usually in the message or a cause).
 */
export function describeError(e: unknown): string {
  const lines: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== undefined; depth++) {
    if (cur instanceof ProviderError) {
      lines.push(
        `${cur.name} kind=${cur.kind}${cur.status === undefined ? "" : ` status=${cur.status}`} retryable=${cur.retryable}${
          cur.retryAfterMs === undefined ? "" : ` retry_after_ms=${cur.retryAfterMs}`
        }: ${cur.message}`,
      );
    } else if (cur instanceof Error) lines.push(`${cur.name}: ${cur.message}`);
    else lines.push(typeof cur === "string" ? cur : JSON.stringify(cur));
    if (depth === 0 && cur instanceof Error && cur.stack !== undefined) lines.push(...cur.stack.split("\n").slice(1, 6));
    cur = cur instanceof Error ? cur.cause : undefined;
    if (cur !== undefined) lines.push("caused by:");
  }
  return lines.join("\n");
}
