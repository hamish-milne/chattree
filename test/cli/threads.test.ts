import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { Conversation } from "../../harness/conversation.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, host, initArgs, testIo } from "./support.ts";

async function started(replies: Reply[]) {
  const server = await FakeServer.start(replies);
  const dir = join(await tempDir(), "p");
  const io = testIo(dir);
  assert.equal(await main(initArgs(server, dir), io), 0, io.stderr);
  return { server, dir };
}
/** Run lines as a plain chat session; resolves to everything it printed. */
async function session(dir: string, ...lines: string[]) {
  const io = testIo(dir, { stdin: `${lines.join("\n")}\n` });
  const code = await main(["chat", "--plain", "-y"], io);
  return { code, out: io.stdout, err: io.stderr, all: `${io.stdout}${io.stderr}` };
}
const tagsOn = async (dir: string, branch: string) => {
  const c = await Conversation.open(host, dir);
  return (await c.readEntriesAt(`refs/heads/${branch}`)).flatMap((e) => (e.ok ? [e.value.$tag] : []));
};

describe("threads", () => {
  test("a new thread starts empty with the same model; messages go to the thread the session is on; switching back works", async () => {
    const { server, dir } = await started([answer("main reply"), answer("side reply")]);
    try {
      const r = await session(dir, "hello main", "/thread new side", "/status", "hello side", "/thread main", "/threads", "/thread");
      assert.equal(r.code, 0, r.err);
      assert.match(r.all, /started thread side/);
      assert.match(r.out, /thread:\s+side/);
      assert.match(r.out, /model:\s+local\/qwen3:4b/);
      assert.match(r.all, /now on thread main/);
      assert.match(r.out, /\* main[\s\S]*side/);
      assert.match(r.out, /thread: main\nworktree: .*p/);
      const sideSent = JSON.parse(server.seen[1]?.body ?? "") as { messages: { content: unknown }[] };
      assert.equal(sideSent.messages.length, 2, "system and the one message: the main thread's exchange did not come along");
      assert.deepEqual((await tagsOn(dir, "side")).filter((t) => t === "user" || t === "assistant"), ["user", "assistant"]);
      assert.deepEqual((await tagsOn(dir, "main")).filter((t) => t === "user" || t === "assistant"), ["user", "assistant"]);
    } finally {
      await server.close();
    }
  });

  test("/fork continues from this thread (or an earlier entry), moves to the fork, and /merge brings it back with a confirmed model summary", async () => {
    const { server, dir } = await started([answer("one"), answer("two"), answer("a fork answer"), answer("They agreed on option B.")]);
    try {
      const r = await session(dir, "first", "second", "/fork 3 detour", "/status", "what about the fork?", "/thread main", "/merge detour", "/history 3");
      assert.equal(r.code, 0, r.err);
      assert.match(r.all, /forked detour from main at an earlier entry/);
      assert.match(r.out, /thread:\s+detour/);
      const forkSent = JSON.parse(server.seen[2]?.body ?? "") as { messages: { role: string; content: string }[] };
      assert.deepEqual(forkSent.messages.map((m) => m.role), ["system", "user", "assistant", "user"], "the fork kept the first exchange, not the second");
      assert.match(r.all, /summary by qwen3:4b/);
      assert.match(r.all, /They agreed on option B\./);
      assert.match(r.all, /merged detour into main: /);
      assert.ok((await tagsOn(dir, "main")).includes("fork_merge"));
    } finally {
      await server.close();
    }
  });

  test("unnamed forks are fork/1, fork/2; /merge with no argument merges this fork into its parent, checks before asking the model, and moves there", async () => {
    const { server, dir } = await started([answer("one"), answer("fork reply"), answer("They settled on B.")]);
    try {
      const r = await session(dir, "hello", "/fork", "in the fork", "/merge", "/thread", "/thread fork/1", "/merge", "/thread main", "/fork");
      assert.match(r.all, /forked fork\/1 from main/);
      assert.match(r.all, /They settled on B\./);
      assert.match(r.all, /merged fork\/1 into main: /);
      assert.match(r.out, /thread: main\n/);
      assert.match(r.err, /already merged/, "a second merge is refused");
      assert.equal(server.seen.length, 3, "the refused merge asked the model for no summary");
      assert.match(r.all, /forked fork\/2 from main/, "the number is not reused");
      assert.ok((await tagsOn(dir, "main")).includes("fork_merge"));
    } finally {
      await server.close();
    }
  });

  test("the model's summary covers only what the fork wrote since it was last merged, and says the main thread is not shown", async () => {
    const { server, dir } = await started([answer("one"), answer("first fork reply"), answer("second fork reply"), answer("Only the second part.")]);
    try {
      await session(dir, "hello", "/fork", "ALPHA question", "/merge Alpha is done.", "/thread fork/1", "BETA question", "/merge");
      const prompt = (JSON.parse(server.seen[3]?.body ?? "") as { messages: { content: string }[] }).messages.at(-1)?.content ?? "";
      assert.match(prompt, /BETA question/);
      assert.doesNotMatch(prompt, /ALPHA question/, "what was already merged is not summarised again");
      assert.doesNotMatch(prompt, /hello/, "nor is the main thread's own conversation");
      assert.match(prompt, /already known to the reader/);
    } finally {
      await server.close();
    }
  });
});
