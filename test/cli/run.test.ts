import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { runRunner } from "../../cli/run.ts";
import { Conversation } from "../../harness/conversation.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, chunk, host, initArgs, testIo, usageChunk } from "./support.ts";
import { WAIT_MS } from "../support/wait.ts";

const callTools = (...calls: { id: string; name: string; args: object }[]): Reply => ({
  acts: [
    ...calls.map((c, i) => chunk({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] })),
    chunk({}, "tool_calls"),
    usageChunk(30, 8),
    "data: [DONE]\n\n",
  ],
});

async function started(replies: Reply[]) {
  const server = await FakeServer.start(replies);
  const dir = join(await tempDir(), "p");
  const io = testIo(dir);
  assert.equal(await main(initArgs(server, dir), io), 0, io.stderr);
  return { server, dir };
}
const open = (dir: string) => Conversation.open(host, dir);
const entries = async (dir: string) => (await (await open(dir)).readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
const say = async (dir: string, text: string) => void (await (await open(dir)).append({ $tag: "user", content: [{ $tag: "text", text }] }));
const replies = async (dir: string) =>
  (await entries(dir)).flatMap((e) => (e.$tag === "assistant" ? e.blocks.flatMap((b) => (b.$tag === "text" && typeof b.text === "string" ? [b.text] : [])) : []));

describe("chattree run", { timeout: 60_000 }, () => {
  test("--once answers a message nobody has answered, and leaves with status 0", async () => {
    const { server, dir } = await started([answer("hello back")]);
    try {
      await say(dir, "hello");
      const io = testIo(dir);
      assert.equal(await main(["run", "--once"], io), 0, io.stderr);
      assert.deepEqual(await replies(dir), ["hello back"]);
      assert.equal(server.seen.length, 1);
      const again = testIo(dir);
      assert.equal(await main(["run", "--once"], again), 0);
      assert.equal(server.seen.length, 1, "nothing left to do");
    } finally {
      await server.close();
    }
  });

  test("a call no grant covers stays a question (status 3); an answer from another session lets the next run carry on", async () => {
    const { server, dir } = await started([callTools({ id: "c1", name: "run", args: { command: "echo hi > out.txt" } }), answer("it ran")]);
    try {
      await say(dir, "go");
      const first = testIo(dir);
      assert.equal(await main(["run", "--once"], first), 3);
      assert.match(first.stderr, /waiting on main: allow .*echo hi/);
      await assert.rejects(readFile(join(dir, "out.txt")), /ENOENT/);
      assert.equal(server.seen.length, 1);
      // another session answers: all it takes is the entry
      await (await open(dir)).append({ $tag: "approval", call_id: "c1", allow: true });
      const second = testIo(dir);
      assert.equal(await main(["run", "--once"], second), 0, second.stderr);
      assert.equal((await readFile(join(dir, "out.txt"), "utf8")).trim(), "hi");
      assert.deepEqual(await replies(dir), ["it ran"]);
    } finally {
      await server.close();
    }
  });

  test("watching: a message appended while it runs is answered, and it stops when told to", async () => {
    const { server, dir } = await started([answer("seen")]);
    try {
      const stop = new AbortController();
      const io = testIo(dir);
      const done = runRunner(io, dir, { stop: stop.signal, pollMs: 50 });
      await new Promise((r) => setTimeout(r, 200));
      await say(dir, "are you there");
      const end = Date.now() + WAIT_MS;
      while ((await replies(dir)).length === 0) {
        if (Date.now() > end) throw new Error("timed out waiting for the reply");
        await new Promise((r) => setTimeout(r, 30));
      }
      stop.abort();
      assert.equal(await done, 0);
      assert.deepEqual(await replies(dir), ["seen"]);
    } finally {
      await server.close();
    }
  });
});
