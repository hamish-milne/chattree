import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { harnessConfig } from "../../harness/config.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { injectionContext, usageRule } from "../../harness/injections.ts";
import type { Prepared } from "../../harness/request.ts";
import { parseConfig } from "../../src/config.ts";

let n = 0;
const id = (): string => `01ARZ3NDEKTSV4RRFFQ69G${String(++n).padStart(4, "0")}`.slice(0, 26).padEnd(26, "0");
const turn = (): ChatEntry => ({ $tag: "assistant", id: id(), provider: "p", model: "m", stop_reason: "end_turn", blocks: [] });
const note = (key: string): ChatEntry => ({ $tag: "injection", id: id(), key, text: "x" });
const prepared = (warnings: Prepared["warnings"]): Prepared => ({ setup: {} as never, context: {} as never, warnings });

describe("what a rule can ask the history", () => {
  test("turns, and the responses since a key last spoke (undefined if it never has)", () => {
    const ctx = injectionContext([turn(), note("a"), turn(), turn(), note("b"), turn()], prepared([]), 0);
    assert.equal(ctx.turns, 4);
    assert.equal(ctx.since("a"), 3);
    assert.equal(ctx.since("b"), 1);
    assert.equal(ctx.since("c"), undefined);
  });

  test("nothing before a fresh-context marker counts", () => {
    const start: ChatEntry = { $tag: "branch_start", id: id(), kind: "subagent", from: { branch: "main", commit: "abc" }, context: "fresh" };
    const ctx = injectionContext([turn(), note("a"), start, turn()], prepared([]), 0);
    assert.equal(ctx.turns, 1);
    assert.equal(ctx.since("a"), undefined);
  });
});

describe("the usage rule", () => {
  const near = prepared([{ kind: "near_limit", message: "this turn will reach $0.9, 90% of the limit of $1" }, { kind: "unknown_price", message: "no price" }]);
  test("speaks when a limit is near, once per kind, and not about anything else", () => {
    const out = usageRule(injectionContext([turn()], near, 0));
    assert.deepEqual(out, [{ key: "usage:near_limit", text: "Usage notice: this turn will reach $0.9, 90% of the limit of $1." }]);
  });
  test("is quiet until five responses have passed, then repeats while the warning stands", () => {
    const quiet = [turn(), note("usage:near_limit"), turn(), turn(), turn(), turn()];
    assert.deepEqual(usageRule(injectionContext(quiet, near, 0)), []);
    assert.equal((usageRule(injectionContext([...quiet, turn()], near, 0)) as unknown[]).length, 1);
    assert.deepEqual(usageRule(injectionContext([turn()], prepared([]), 0)), []);
  });
});

describe("harness.yml", () => {
  const ok = async (rules: string) => parseConfig(`providers: {}\ninjections:\n${rules}`, harnessConfig);
  test("defaults, and a valid rule", async () => {
    const r = await parseConfig("providers: {}\n", harnessConfig);
    assert.ok(r.ok && r.value.injections.usage === true && Object.keys(r.value.injections.rules).length === 0);
    const v = await ok("  usage: false\n  rules:\n    style:\n      every: 10\n      text: Be brief.\n");
    assert.ok(v.ok && v.value.injections.usage === false && v.value.injections.rules["style"]?.first === false);
  });
  test("a rule needs text or a file (not both), a sane key, and a positive interval; a repeated key is a parse error", async () => {
    for (const rules of ["  rules:\n    a:\n      every: 1\n", "  rules:\n    a:\n      every: 1\n      text: t\n      file: f\n", "  rules:\n    A b:\n      every: 1\n      text: t\n", "  rules:\n    a:\n      every: 0\n      text: t\n", "  rules:\n    a: {every: 1, text: t}\n    a: {every: 2, text: u}\n"]) {
      assert.equal((await ok(rules)).ok, false, rules);
    }
  });
});
