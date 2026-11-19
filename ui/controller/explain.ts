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
      "nothing was added for this attempt; send again to retry",
    );
  if (e instanceof ContextFull || e instanceof LimitExceeded) return e.message;
  if (e instanceof AppError) return e.hint === undefined ? e.message : hint(e.message, e.hint);
  return e instanceof Error ? e.message : String(e);
}
