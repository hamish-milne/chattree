import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import type { Io } from "../../cli/io.ts";
import { Conversation } from "../../harness/conversation.ts";
import { contextEntries } from "../../harness/context.ts";
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
async function session(dir: string, lines: string[], opts: { io?: Partial<Io> } = {}) {
  const io = testIo(dir, { stdin: `${lines.join("\n")}\n`, ...opts.io });
  const code = await main(["chat", "--plain", "-y"], io);
  return { code, out: io.stdout, err: io.stderr, all: `${io.stdout}${io.stderr}` };
}
const requestMessages = (server: FakeServer, n: number) => (JSON.parse(server.seen[n]?.body ?? "") as { messages: { role: string; content: string }[] }).messages;

describe("/compact", () => {
  test("a given summary replaces the range in what the model sees, and nothing is deleted", async () => {
    const { server, dir } = await started([answer("a1"), answer("a2"), answer("a3")]);
    try {
      // entries, counting back: 1 assistant a2, 2 user q2, 3 assistant a1, 4 user q1 (setup entries come first)
      const r = await session(dir, ["q1", "q2", "/compact 3 4", "/compact 4 3 Earlier we agreed on plan B.", "q3"]);
      assert.match(r.err, /the range runs backwards/);
      const c = await Conversation.open(host, dir);
      const all = (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
      assert.ok(all.some((e) => e.$tag === "compaction"));
      assert.equal(all.filter((e) => e.$tag === "user").length, 3, "the transcript still has every message");
      const seen = requestMessages(server, 2).map((m) => m.content).join("\n");
      assert.match(seen, /Earlier we agreed on plan B\./);
      assert.doesNotMatch(seen, /\bq1\b/);
      assert.match(seen, /\bq2\b/);
      assert.ok(contextEntries(all).length < all.length);
    } finally {
      await server.close();
    }
  });

  test("without a summary the model writes one, which is shown and confirmed", async () => {
    const { server, dir } = await started([answer("a1"), answer("The summary the model wrote.")]);
    try {
      const r = await session(dir, ["q1", "/compact 2 1"]);
      assert.match(r.all, /summary of 2 entries by qwen3:4b/);
      assert.match(r.out, /The summary the model wrote\./);
      assert.match(r.all, /compacted:/);
      const asked = requestMessages(server, 1).at(-1)?.content ?? "";
      assert.match(asked, /Summarise this part of a conversation[\s\S]*q1[\s\S]*a1/);
    } finally {
      await server.close();
    }
  });

  test("bad references are errors", async () => {
    const { server, dir } = await started([answer("a1")]);
    try {
      const r = await session(dir, ["q1", "/compact", "/compact 1", "/compact 99 1", "/compact 1 2"]);
      assert.match(r.err, /give the first and last entry to replace/);
      assert.match(r.err, /no entry matches 99/);
      assert.match(r.err, /the range runs backwards/);
    } finally {
      await server.close();
    }
  });
});

describe("/export, /log, /clear", () => {
  test("/export writes Markdown of the thread, here or to a file that is not overwritten without --force", async () => {
    const { server, dir } = await started([answer("An answer with `code`.")]);
    try {
      await writeFile(join(dir, "note.txt"), "hello\n");
      const r = await session(dir, ["see the file", "/export", "/export out.md", "/export out.md", "/export out.md --force"]);
      assert.match(r.out, /^# main$/m);
      assert.match(r.out, /## You\n\nsee the file/);
      assert.match(r.out, /## qwen3:4b\n\nAn answer with `code`\./);
      assert.match(r.err, /out\.md already exists/);
      assert.match(await readFile(join(dir, "out.md"), "utf8"), /## You/);
      const att = await session(dir, ["/attach note.txt", "with file", "/export"]);
      assert.match(att.out, /\*Attached note\.txt \(text\/plain, 6 bytes\)\.\*/);
    } finally {
      await server.close();
    }
  });

  test("/log lists commits newest first", async () => {
    const { server, dir } = await started([answer("a1")]);
    try {
      const r = await session(dir, ["q1", "/log 3", "/log x"]);
      const lines = r.out.split("\n").filter((l) => /^[0-9a-f]{8}  /.test(l));
      assert.equal(lines.length, 3);
      assert.match(lines[0] ?? "", /assistant/);
      assert.match(lines[1] ?? "", /user/);
      assert.match(r.err, /x is not a number of commits/);
    } finally {
      await server.close();
    }
  });

  test("/clear prints nothing in plain output", async () => {
    const { server, dir } = await started([answer("a1")]);
    try {
      const r = await session(dir, ["/clear"]);
      assert.equal(r.code, 0);
      assert.doesNotMatch(r.all, /\x1b/);
    } finally {
      await server.close();
    }
  });
});

describe("editing the draft", () => {
  test("/edit and /draft edit put the draft in the editor and take what comes back; /say sends it", async () => {
    const { server, dir } = await started([answer("got it")]);
    try {
      let opened = "";
      const edit = async (path: string): Promise<boolean> => {
        opened = await readFile(path, "utf8");
        await writeFile(path, `${opened}\nsecond paragraph\n`);
        return true;
      };
      const r = await session(dir, ["/draft set first paragraph", "/edit", "/draft show", "/draft edit", "/say"], { io: { edit } });
      assert.equal(opened.includes("second paragraph") ? "second round" : opened, "second round", "the second edit opened what the first saved");
      assert.match(r.out, /first paragraph\nsecond paragraph/);
      const sent = requestMessages(server, 0).at(-1)?.content;
      assert.equal(sent, "first paragraph\nsecond paragraph\nsecond paragraph");
    } finally {
      await server.close();
    }
  });
});
