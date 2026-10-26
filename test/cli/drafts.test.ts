import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import type { Io } from "../../cli/io.ts";
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
async function session(dir: string, lines: string[], opts: { io?: Partial<Io>; yes?: boolean } = {}) {
  const io = testIo(dir, { stdin: `${lines.join("\n")}\n`, ...opts.io });
  const code = await main(["chat", "--plain", ...(opts.yes === false ? [] : ["-y"])], io);
  return { code, out: io.stdout, err: io.stderr, all: `${io.stdout}${io.stderr}` };
}
/** An editor that writes the next of `texts` into the file it is given (an empty string writes nothing). */
const editorWriting = (...texts: string[]) => {
  const opened: string[] = [];
  return {
    opened,
    edit: async (path: string): Promise<boolean> => {
      opened.push(await readFile(path, "utf8"));
      await writeFile(path, texts.shift() ?? "");
      return true;
    },
  };
};
const userTexts = async (dir: string): Promise<string[]> =>
  (await (await Conversation.open(host, dir)).readEntries()).flatMap((e) => (e.ok && e.value.$tag === "user" ? [e.value.content.map((p) => (p.$tag === "text" ? p.text : `[${p.name ?? "file"}]`)).join("")] : []));
const sentTo = (server: FakeServer, n: number): string => (JSON.parse(server.seen[n]?.body ?? "") as { messages: { content: string }[] }).messages.at(-1)?.content ?? "";

describe("named drafts", () => {
  test("/draft opens the editor on a new numbered draft, /draft <name> on a named one; /drafts lists; /send sends and removes", async () => {
    const { server, dir } = await started([answer("one"), answer("two")]);
    try {
      const ed = editorWriting("first idea\nwith two lines\n", "second idea\n", "named one\n");
      const r = await session(dir, ["/draft", "/draft", "/draft plan", "/drafts", "/send plan", "/send 2", "/drafts"], { io: { edit: ed.edit } });
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(ed.opened, ["", "", ""], "each new draft opened empty");
      assert.match(r.out, /^1 {2}25 characters {2}first idea with two lines$/m);
      assert.match(r.out, /^2 {2}/m);
      assert.match(r.out, /^plan {2}/m);
      assert.deepEqual(await userTexts(dir), ["named one", "second idea"]);
      assert.equal(sentTo(server, 0), "named one");
      assert.match(r.out, /^1 {2}25 characters/m, "the last /drafts shows only draft 1");
      assert.equal(r.out.split("\n").filter((l) => /^(1|2|plan) {2}\d+ characters/.test(l)).length, 3 + 1);
    } finally {
      await server.close();
    }
  });

  test("editing an existing draft reopens its text; an empty save removes it; the next number is the smallest free one", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      const ed = editorWriting("a\n", "", "b\n", "c\n");
      const r = await session(dir, ["/draft", "/draft 1", "/draft", "/draft", "/drafts"], { io: { edit: ed.edit } });
      assert.deepEqual(ed.opened, ["", "a", "", ""]);
      assert.match(r.all, /draft 1 is empty, so it was removed/);
      assert.match(r.out, /^1 {2}\d+ characters {2}b$/m, "the freed number 1 was used again");
      assert.match(r.out, /^2 {2}\d+ characters {2}c$/m);
    } finally {
      await server.close();
    }
  });

  test("/send leaves the prompt draft alone, and so does /say with text; /send with no name works for a single draft only", async () => {
    const { server, dir } = await started([answer("a"), answer("b"), answer("c")]);
    try {
      const ed = editorWriting("from the editor\n", "another\n", "third\n");
      const r = await session(dir, ["/draft set still typing", "/draft x", "/send", "/say literal text", "/draft show", "/draft y", "/draft z", "/send"], { io: { edit: ed.edit } });
      assert.deepEqual((await userTexts(dir)), ["from the editor", "literal text"]);
      assert.match(r.out, /^still typing$/m, "the prompt draft survived both sends");
      assert.match(r.err, /say which draft/);
    } finally {
      await server.close();
    }
  });

  test("mistakes: reserved names, unknown drafts, nothing to send, no editor", async () => {
    const { server, dir } = await started([answer("a")]);
    try {
      const r = await session(dir, ["/draft a b", "/send", "/send nope", "/discard", "/discard nope", "/draft one"]);
      assert.match(r.err, /a draft's name is one word/);
      assert.match(r.err, /there are no named drafts/);
      assert.match(r.err, /say which draft, or all/);
      assert.match(r.err, /there is no draft nope/);
      assert.match(r.err, /there is no editor here/);
      const reserved = await session(dir, ["/draft set"], {});
      assert.equal(reserved.code, 0);
    } finally {
      await server.close();
    }
  });

  test("named drafts survive leaving the session, and /discard removes them", async () => {
    const { server, dir } = await started([answer("a")]);
    try {
      const ed = editorWriting("kept for later\n", "second\n");
      const first = await session(dir, ["/draft later", "/draft"], { io: { edit: ed.edit } });
      assert.equal(first.code, 0, first.err);
      const second = await session(dir, ["/drafts", "/discard later", "/drafts", "/discard all", "/drafts"]);
      assert.match(second.out, /^later {2}\d+ characters {2}kept for later$/m);
      assert.match(second.out, /^1 {2}/m);
      assert.match(second.all, /removed 1 draft/);
      assert.match(second.all, /no named drafts/);
    } finally {
      await server.close();
    }
  });
});

describe("/undo", () => {
  test("goes back to just before your last message and puts it in the draft; the old tip is kept and the thread carries on", async () => {
    const { server, dir } = await started([answer("a1"), answer("a2"), answer("a3")]);
    try {
      const r = await session(dir, ["first question", "second question", "/undo", "/draft show", "/log 2"]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.all, /this takes main back 2 commits, dropping 1 user, 1 assistant/);
      assert.match(r.all, /your message "second question" goes into a draft/);
      assert.match(r.out, /^second question$/m);
      assert.deepEqual(await userTexts(dir), ["first question"]);
      const hash = /git branch <name> ([0-9a-f]{40})/.exec(r.err)?.[1];
      assert.ok(hash, "the old tip is printed in full");
      assert.match(r.err, /also kept as refs\/chattree\/undone\/main\//);
      const recovered = await host.exec("git", ["cat-file", "-t", hash], { cwd: dir });
      assert.equal(new TextDecoder().decode(recovered.stdout).trim(), "commit");

      const again = await session(dir, ["/draft show", "better second question"]);
      assert.match(again.out, /^second question$/m, "the draft was saved with the session");
      assert.deepEqual(await userTexts(dir), ["first question", "better second question"]);
      const sent = JSON.parse(server.seen[2]?.body ?? "") as { messages: { role: string }[] };
      assert.deepEqual(sent.messages.map((m) => m.role), ["system", "user", "assistant", "user"], "the undone exchange is not sent");
    } finally {
      await server.close();
    }
  });

  test("/undo n goes back that many commits; the earliest undone message becomes the draft; an existing draft is not overwritten", async () => {
    const { server, dir } = await started([answer("a1"), answer("a2")]);
    try {
      const r = await session(dir, ["q1", "q2", "/draft set something I was typing", "/undo 4", "/draft show", "/drafts"]);
      assert.match(r.all, /back 4 commits/);
      assert.match(r.all, /you already had a draft in progress, so the message is saved as draft 1/);
      assert.match(r.out, /^something I was typing$/m);
      assert.match(r.out, /^1 {2}\d+ characters {2}q1$/m);
      assert.deepEqual(await userTexts(dir), []);
    } finally {
      await server.close();
    }
  });

  test("files the message had attached are named as not carried over; workspace files go back too", async () => {
    const { server, dir } = await started([answer("a1")]);
    try {
      await writeFile(join(dir, "pic.txt"), "attached\n");
      await writeFile(join(dir, "work.txt"), "before\n");
      const r = await session(dir, ["/attach pic.txt", "look at this", "/undo", "/draft show"]);
      assert.match(r.all, /its attached files \(pic\.txt\) are not carried into the draft/);
      assert.match(r.out, /^look at this$/m);
      assert.deepEqual(await userTexts(dir), []);
    } finally {
      await server.close();
    }
  });

  test("without a yes nothing changes; bad numbers and nothing to undo are errors", async () => {
    const { server, dir } = await started([answer("a1")]);
    try {
      const r = await session(dir, ["q1", "/undo"], { yes: false });
      assert.match(r.err, /nothing was changed/);
      assert.deepEqual(await userTexts(dir), ["q1"]);
      const bad = await session(dir, ["/undo x", "/undo 1 2", "/undo 999"]);
      assert.match(bad.err, /x is not a number of commits/);
      assert.match(bad.err, /1 2 is not a number of commits/);
      assert.match(bad.err, /the thread is not 999 commits long/);
      const empty = await started([answer("a")]);
      try {
        const e = await session(empty.dir, ["/undo"]);
        assert.match(e.err, /there is no message of yours to undo/);
      } finally {
        await empty.server.close();
      }
    } finally {
      await server.close();
    }
  });
});
