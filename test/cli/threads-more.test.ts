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

/** The second half of the thread tests: Windows runs each test in about 25 s, so one file of eight went past the 3-minute limit. */
describe("threads, part two", () => {
  test("worktrees get safe directory names (no percent-encoding), and chattree.worktrees moves them", async () => {
    const { server, dir } = await started([answer("one")]);
    try {
      const a = await session(dir, "hello", "/fork", "/thread", "/thread main", "/fork my/odd%name", "/thread");
      const paths = a.out.split("\n").filter((l) => l.startsWith("worktree: ")).map((l) => l.slice(10).replace(/\\/g, "/"));
      assert.deepEqual(paths.map((p) => p.slice(p.indexOf(".chattree"))), [".chattree/threads/fork-1", ".chattree/threads/my-odd-name"]);
      assert.doesNotMatch(a.all, /%2F/);
      execFileSync("git", ["-C", dir, "config", "chattree.worktrees", "../elsewhere"]);
      const b = await session(dir, "/fork", "/thread");
      const moved = (b.out.split("\n").find((l) => l.startsWith("worktree: ")) ?? "").slice(10).replace(/\\/g, "/");
      assert.equal(moved, `${join(dir, "..", "elsewhere").replace(/\\/g, "/")}/fork-2`);
    } finally {
      await server.close();
    }
  });

  test("/merge with the summary given asks no model; a missing thread and a repeat merge say why", async () => {
    const { server, dir } = await started([answer("one"), answer("two")]);
    try {
      const r = await session(dir, "hello", "/fork side", "side question", "/thread main", "/merge nonexistent", "/merge side We settled on B.", "/merge side again");
      assert.match(r.err, /nonexistent/);
      assert.match(r.all, /merged side into main: /);
      assert.match(r.err, /already merged/);
      assert.equal(server.seen.length, 2, "no request was made for the summary");
      const c = await Conversation.open(host, dir);
      const merge = (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : [])).find((e) => e.$tag === "fork_merge");
      assert.equal(merge?.$tag === "fork_merge" && merge.summary, "We settled on B.");
    } finally {
      await server.close();
    }
  });

  test("archiving hides a thread from /threads until asked for; unarchive brings it back", async () => {
    const { server, dir } = await started([answer("one")]);
    try {
      const r = await session(dir, "/thread new old", "/thread main", "/thread archive old", "/threads", "/threads archived", "/thread unarchive old", "/threads");
      assert.equal(r.code, 0, r.err);
      assert.match(r.all, /old is archived/);
      assert.match(r.all, /old is no longer archived/);
      // first /threads: main only; archived listing: old only; last: both
      const lines = r.out.split("\n").filter((l) => /^[* ] (main|old)\b/.test(l)).map((l) => l.trim().split(/\s+/)[1] === undefined ? l : (l.includes("archived") ? "old-archived" : l.trim().replace(/^\* /, "").split(/\s+/)[0]));
      assert.deepEqual(lines, ["main", "old-archived", "main", "old"]);
    } finally {
      await server.close();
    }
  });

  test("usage mistakes are errors, not crashes", async () => {
    const { server, dir } = await started([answer("one")]);
    try {
      const r = await session(dir, "/thread nope", "/thread new", "/thread a b", "/fork 1 2 3", "/thread new x --from 99", "/merge");
      assert.match(r.err, /there is no thread named nope/);
      assert.match(r.err, /give the new thread's name/);
      assert.match(r.err, /give one thread name/);
      assert.match(r.err, /too many arguments/);
      assert.match(r.err, /no entry matches 99/);
      assert.match(r.err, /main is not a fork/);
      assert.notEqual(r.code, 0);
    } finally {
      await server.close();
    }
  });
});
