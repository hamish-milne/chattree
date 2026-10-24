import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { contextEntries } from "../../harness/context.ts";
import { Conversation, type NewEntry } from "../../harness/conversation.ts";
import { verifyHistory } from "../../harness/verify.ts";
import { Rng } from "../support/gen.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const CONFIG = "version: 1\nmodel:\n  provider: anthropic\n  model: m0\n";
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const reply = (text: string): NewEntry => ({ $tag: "assistant", provider: "anthropic", model: "m", blocks: [{ $tag: "text", text }], stop_reason: "end_turn" });
const FILES = ["a.txt", "b.txt", "dir/c.txt", "dir/d.txt"];

async function scribble(c: Conversation, r: Rng): Promise<void> {
  const f = r.pick(FILES);
  await mkdir(dirname(join(c.dir, f)), { recursive: true });
  await writeFile(join(c.dir, f), `${r.int(1e6)}\n${"line\n".repeat(r.int(4))}`);
}

const text = (r: Rng): string => (r.chance(0.1) ? "big ".repeat(1500 + r.int(500)) : `t${r.int(1e6)}${r.chance(0.3) ? "\n- : #'\"" : ""}`);

/** Random operations on a conversation, checked against a model of what each branch's transcript should contain. */
async function run(seed: number, steps: number): Promise<void> {
  const r = new Rng(seed);
  const dir = join(await tempDir(), "conv");
  let convo = await Conversation.create(host, dir, { config: CONFIG });
  const idsOf = async (c: Conversation): Promise<(string | undefined)[]> => (await c.index()).map((x) => x.id);
  const model: (string | undefined)[] = await idsOf(convo); // main's entry ids, in order
  const log: string[] = [];
  const note = (s: string): void => void log.push(s);
  const grow = async (c: Conversation, e: NewEntry, into: (string | undefined)[]): Promise<void> => void into.push((await c.append(e)).id);

  try {
    for (let i = 0; i < steps; i++) {
      const op = r.int(14);
      if (op <= 3) {
        note("append");
        await grow(convo, r.chance(0.5) ? user(text(r)) : reply(text(r)), model);
      } else if (op === 4) {
        note("scribble+snapshot");
        await scribble(convo, r);
        await convo.snapshot();
      } else if (op === 5) {
        note("subagent");
        await scribble(convo, r);
        const s = await convo.spawnSubagent({ brief: `job ${i}`, callId: `c${i}` });
        const child = s.conversation as Conversation;
        for (let k = r.int(3); k >= 0; k--) {
          await scribble(child, r);
          await child.append(r.chance(0.5) ? user(text(r)) : reply(text(r)));
        }
        const out = await convo.finishSubagent(r.chance(0.5) ? child : child.branch, { summary: `done ${i}`, callId: `c${i}` });
        model.push(out.entry.id);
      } else if (op === 6) {
        note("fork+merge");
        const f = await convo.fork();
        const child = f.conversation as Conversation;
        for (let k = r.int(3); k >= 0; k--) {
          await scribble(child, r);
          await child.append(user(text(r)));
        }
        if (r.chance(0.7)) model.push((await convo.mergeFork(child, { summary: `fork ${i}` })).entry.id);
        else note("(fork abandoned)");
      } else if (op === 7) {
        note("compact");
        const values = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
        const visible = contextEntries(values).flatMap((e) => ("id" in e ? [e.id] : []));
        if (visible.length >= 2) {
          const a = r.int(visible.length);
          const b = a + r.int(visible.length - a);
          model.push((await convo.compact({ from: visible[a] as string, to: visible[b] as string, summary: `sum ${i}` })).id);
        }
      } else if (op === 8) {
        note("config");
        const m = `m${r.int(5)}`;
        const res = await convo.changeConfig((d) => d.setIn(["model", "model"], m));
        if (res.entry !== undefined) model.push(res.entry.id);
      } else if (op === 9) {
        note("interrupt");
        await grow(convo, { $tag: "interrupted", by: r.chance(0.5) ? "user" : "error", partial: [] }, model);
      } else if (op === 10) {
        note("reopen");
        convo = await Conversation.open(host, dir);
      } else {
        note("append");
        await grow(convo, user(text(r)), model);
      }
      if (i % 10 === 9) await check();
    }
    await check(true);
    if (process.env["FUZZ_LOG"] !== undefined) console.log(`seed ${seed}: ${[...new Set(log)].join(",")} (${model.length} entries, ${(await convo.listBranches()).length} branches)`);
  } catch (e) {
    throw new Error(`seed ${seed}: ${log.join(", ")}\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }

  async function check(deep = false): Promise<void> {
    const mine = await idsOf(convo);
    assert.deepEqual(mine, model, "the transcript is exactly what the operations appended");
    await assertHistoryInvariants(convo);
    for (const b of await convo.listBranches()) {
      const problems = await verifyHistory(convo, { rev: b.name, deep });
      assert.deepEqual(problems, [], `branch ${b.name}`);
    }
  }
}

describe("random operations", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    test(`seed ${seed}`, { timeout: 240_000 }, () => run(seed, 40));
  }
});
