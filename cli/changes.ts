import { ChangeNotAllowed } from "../harness/setup.ts";
import type { ChangeKind } from "../harness/entries.ts";
import type { Ctx } from "./engine.ts";
import type { Output } from "./output.ts";

/**
 * Run a setup change that the library may refuse until the user agrees (docs/cli.md, section 8): the refusal is shown with
 * what each change does, the user is asked, and the call repeats with exactly those kinds allowed. A changed price table is
 * pinned first, as `/pricing pin` would. Returns what `fn` returned, or `undefined` if the user said no.
 */
export async function* withConfirmation<T>(ctx: Ctx, fn: (allow: ChangeKind[]) => Promise<T>): AsyncGenerator<Output, { done: true; value: T } | { done: false }> {
  let allow: ChangeKind[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { done: true, value: await fn(allow) };
    } catch (e) {
      if (!(e instanceof ChangeNotAllowed)) throw e;
      yield { type: "notice", message: e.changes.map((c) => `${c.kind}: ${c.message}`).join("\n") };
      if (!(await ctx.confirm("Make this change?"))) {
        yield { type: "notice", message: "nothing was changed" };
        return { done: false };
      }
      if (e.allowWith.includes("pricing_changed")) {
        await ctx.convo.pinPricing();
        yield { type: "notice", message: "pinned the provider's current prices" };
      }
      allow = [...new Set([...allow, ...e.allowWith.filter((k) => k !== "pricing_changed")])];
    }
  }
  throw new Error("the change kept being refused");
}
