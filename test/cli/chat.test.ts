import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { PromptBuffer } from "../../cli/prompt.ts";
import { emptyState } from "../../cli/engine.ts";
import { Conversation } from "../../harness/conversation.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, chunk, host, initArgs, testIo } from "./support.ts";

const ESC = String.fromCharCode(27);
const strip = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "").replace(/\r/g, "");
const PASTE = (s: string): string => `${ESC}[200~${s}${ESC}[201~`;

async function waitFor(pred: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function started(replies: Reply[]) {
  const server = await FakeServer.start(replies);
  const dir = join(await tempDir(), "p");
  const io = testIo(dir);
  assert.equal(await main(initArgs(server, dir), io), 0, io.stderr);
  return { server, dir };
}

/** A terminal for the session: keystrokes go in `input`, what the user would see is `screen()`. */
function terminal(dir: string, extra: string[] = [], over: Partial<import("../../cli/io.ts").Io> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = "";
  output.on("data", (d: Buffer) => void (raw += d.toString()));
  const io = testIo(dir, { interactive: true, tty: { input, output }, ...over });
  const done = main(["chat", "--thread", "main", ...extra], io);
  return {
    io,
    type: (s: string) => void input.write(s),
    screen: () => strip(raw + io.stdout),
    raw: () => raw + io.stdout,
    done,
    end: () => void input.end(),
  };
}
const entries = async (dir: string) => (await (await Conversation.open(host, dir)).readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
const userText = (e: unknown): string => ((e as { content: { text?: string }[] }).content.map((p) => p.text ?? "").join(""));

describe("the prompt rules", () => {
  const press = (p: PromptBuffer, ...lines: string[]) => lines.map((l) => p.line(l).kind);
  test("text accumulates and a blank line sends; commands run at once and leave the draft alone", () => {
    const st = emptyState();
    const p = new PromptBuffer(st);
    assert.deepEqual(press(p, "hello", "world", ""), ["none", "none", "send"]);
    assert.equal(st.draft, "hello\nworld");
    assert.deepEqual(p.line("/status"), { kind: "command", line: "/status" });
    assert.equal(st.draft, "hello\nworld");
    assert.deepEqual(press(new PromptBuffer(emptyState()), "", "  "), ["none", "none"], "blank lines with no draft do nothing");
  });
  test("a trailing backslash continues, so a paragraph break can be typed; // is a literal slash", () => {
    const st = emptyState();
    const p = new PromptBuffer(st);
    assert.deepEqual(press(p, "one\\", "\\", "two", "//not a command", ""), ["none", "none", "none", "none", "send"]);
    assert.equal(st.draft, "one\n\ntwo\n/not a command");
  });
  test("a pasted block is taken whole, blank lines and slashes included; a recalled multi-line message sends again", () => {
    const st = emptyState();
    const p = new PromptBuffer(st);
    for (const l of ["/looks like a command", "", "second paragraph"]) assert.equal(p.line(l, true).kind, "none");
    assert.equal(st.draft, "/looks like a command\n\nsecond paragraph");
    const r = new PromptBuffer(emptyState());
    assert.equal(r.line("a\nb").kind, "send");
    assert.equal(r.draft, "a\nb");
  });
});

describe("the interactive session", () => {
  test("type, finish with a blank line, see the reply stream, and the exchange is committed; /quit leaves", async () => {
    const { server, dir } = await started([answer("Hello from the model.", 12, 4)]);
    try {
      const t = terminal(dir, ["--plain=false"].slice(1));
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type("hi there\n");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(server.seen.length, 0, "a line alone does not send");
      t.type("\n");
      await waitFor(() => t.screen().includes("Hello from the model."), "the reply");
      await waitFor(() => /\[12 in, 4 out/.test(t.screen()), "the usage line");
      t.type("/quit\n");
      assert.equal(await t.done, 0);
      assert.deepEqual((await entries(dir)).map((e) => e.$tag).slice(-2), ["user", "assistant"]);
      assert.equal(userText((await entries(dir)).at(-2)), "hi there");
      assert.match(t.raw(), /\x1b\[\?2004h/, "bracketed paste was switched on");
      assert.match(t.raw(), /\x1b\[\?2004l/, "and off again");
    } finally {
      await server.close();
    }
  });

  test("a pasted block with blank lines is one message; a slash command inside it is not run", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      const t = terminal(dir);
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type(PASTE("first paragraph\n\n/status is not a command here\n\nlast"));
      await new Promise((r) => setTimeout(r, 50));
      t.type("\n\n");
      await waitFor(() => server.seen.length === 1, "the request");
      await waitFor(() => t.screen().includes("ok"), "the reply");
      t.type("/quit\n");
      await t.done;
      assert.equal(userText((await entries(dir)).find((e) => e.$tag === "user")), "first paragraph\n\n/status is not a command here\n\nlast");
    } finally {
      await server.close();
    }
  });

  test("backslash continues a line; commands run without sending the draft; Ctrl-C clears it and twice leaves", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      const t = terminal(dir);
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type("one\\\ntwo\n/attachments\n");
      await waitFor(() => t.screen().includes("nothing is staged"), "the command output");
      assert.equal(server.seen.length, 0);
      t.type("\x03");
      await waitFor(() => t.screen().includes("draft cleared"), "the clear notice");
      t.type("typed\n\n");
      await waitFor(() => server.seen.length === 1, "the request");
      await waitFor(() => /\[\d+ in/.test(t.screen()), "the end of the reply");
      assert.equal(userText((await entries(dir)).find((e) => e.$tag === "user")), "typed", "the cleared draft was not sent");
      t.type("\x03");
      await waitFor(() => t.screen().includes("Ctrl-C again"), "the hint");
      t.type("\x03");
      assert.equal(await t.done, 0);
    } finally {
      await server.close();
    }
  });

  test("Ctrl-C during a request stops it: what arrived is kept as an interrupted entry", async () => {
    const { server, dir } = await started([{ acts: [chunk({ content: "partial " }), chunk({ content: "reply" }), { hang: true }] }]);
    try {
      const t = terminal(dir);
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type("go\n\n");
      await waitFor(() => t.screen().includes("partial reply"), "streamed text");
      t.type("\x03");
      await waitFor(() => /interrupted|stopped/.test(t.screen()), "the stop");
      await waitFor(async () => (await entries(dir)).some((e) => e.$tag === "interrupted"), "the interrupted entry");
      t.type("/quit\n");
      assert.equal(await t.done, 0);
    } finally {
      await server.close();
    }
  });

  test("messages typed during a request wait and are sent in order afterwards", async () => {
    const { server, dir } = await started([{ acts: [{ wait: 300 }, chunk({ content: "first answer" }), chunk({}, "stop"), "data: [DONE]\n\n"] }, answer("second answer")]);
    try {
      const t = terminal(dir);
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type("one\n\n");
      await waitFor(() => server.seen.length === 1, "the first request");
      t.type("two\n\n");
      await waitFor(() => t.screen().includes("second answer"), "the second reply", 8000);
      t.type("/quit\n");
      await t.done;
      assert.deepEqual((await entries(dir)).filter((e) => e.$tag === "user").map(userText), ["one", "two"]);
      assert.ok(t.screen().indexOf("first answer") < t.screen().indexOf("second answer"));
    } finally {
      await server.close();
    }
  });

  test("a spinner shows while waiting and is gone when the reply starts", async () => {
    const { server, dir } = await started([{ acts: [{ wait: 400 }, chunk({ content: "late" }), chunk({}, "stop"), "data: [DONE]\n\n"] }]);
    try {
      const t = terminal(dir, []);
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type("hello\n\n");
      await waitFor(() => /Ctrl-C stops it/.test(t.screen()), "the spinner");
      await waitFor(() => t.screen().includes("late"), "the reply");
      t.type("/quit\n");
      await t.done;
    } finally {
      await server.close();
    }
  });

  test("Tab completes command names and file paths", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      await mkdir(join(dir, "docs"), { recursive: true });
      await writeFile(join(dir, "docs", "readme.txt"), "x\n");
      const t = terminal(dir);
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type("/attachm\t");
      await new Promise((r) => setTimeout(r, 100)); // completion is asynchronous
      t.type("\n");
      await waitFor(() => t.screen().includes("nothing is staged"), "/attachments ran");
      t.type("/attach docs/rea\t");
      await new Promise((r) => setTimeout(r, 100));
      t.type("\n");
      await waitFor(() => t.screen().includes("staged readme.txt"), "the file was staged");
      t.type("/quit\n");
      await t.done;
    } finally {
      await server.close();
    }
  });

  test("a draft and staged files survive leaving, and the next session says so and has them", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      await writeFile(join(dir, "n.txt"), "note\n");
      const a = terminal(dir);
      await waitFor(() => a.screen().includes("Ctrl-D leaves"), "the prompt");
      a.type("unfinished thought\n/attach n.txt\n");
      await waitFor(() => a.screen().includes("staged n.txt"), "staged");
      a.end(); // Ctrl-D / end of input
      assert.equal(await a.done, 0);
      const b = terminal(dir);
      await waitFor(() => b.screen().includes("Ctrl-D leaves"), "the prompt");
      assert.match(b.screen(), /resumed: 1 line of draft, 1 staged file/);
      b.type("\n");
      await waitFor(() => server.seen.length === 1, "the request");
      await waitFor(() => /\[\d+ in/.test(b.screen()), "the reply");
      b.type("/quit\n");
      await b.done;
      const sent = (await entries(dir)).find((e) => e.$tag === "user") as { content: { $tag: string }[] };
      assert.deepEqual(sent.content.map((p) => p.$tag), ["text", "attachment"]);
      // nothing pending now: no session file is left behind
      const c = terminal(dir);
      await waitFor(() => c.screen().includes("Ctrl-D leaves"), "the prompt");
      assert.doesNotMatch(c.screen(), /resumed/);
      c.end();
      await c.done;
    } finally {
      await server.close();
    }
  });

  test("entries another session adds appear above the prompt", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      const t = terminal(dir);
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      const other = await Conversation.open(host, dir);
      await other.append({ $tag: "user", content: [{ $tag: "text", text: "typed in another terminal" }] });
      await waitFor(() => t.screen().includes("typed in another terminal"), "the foreign entry", 8000);
      assert.match(t.screen(), /from another session/);
      t.type("/quit\n");
      await t.done;
    } finally {
      await server.close();
    }
  });

  test("startup shows the exchange since the last message and the thread line", async () => {
    const { server, dir } = await started([answer("an earlier answer")]);
    try {
      assert.equal(await main(["say", "earlier question"], testIo(dir)), 0);
      const t = terminal(dir);
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      assert.match(t.screen(), /earlier question[\s\S]*an earlier answer[\s\S]*thread main · local\/qwen3:4b/);
      t.end();
      await t.done;
    } finally {
      await server.close();
    }
  });
});

describe("handing the terminal over", () => {
  test("/edit gives the terminal to the editor, switches paste mode off and on around it, and the draft comes back", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      let during = "";
      const t = terminal(dir, [], {
        edit: async (path: string) => {
          during = "editing";
          await writeFile(path, "written in the editor\n");
          return true;
        },
      });
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type("/edit\n");
      await waitFor(() => t.screen().includes("the draft is updated"), "the edit finished");
      assert.equal(during, "editing");
      const raw = t.raw();
      const off = raw.lastIndexOf("\x1b[?2004l");
      const on = raw.lastIndexOf("\x1b[?2004h");
      assert.ok(off >= 0 && on > off, "paste mode was off while the editor ran and on again after");
      t.type("\n");
      await waitFor(() => server.seen.length === 1, "the request");
      assert.equal(JSON.parse(server.seen[0]?.body ?? "").messages.at(-1).content, "written in the editor");
      t.type("/clear\n");
      await waitFor(() => t.raw().includes("\x1b[2J"), "the screen was cleared");
      t.type("/quit\n");
      await t.done;
    } finally {
      await server.close();
    }
  });
});

describe("plain chat", () => {
  test("lines from standard input are messages and commands, in order, with a failing request making the exit status 1", async () => {
    const { server, dir } = await started([answer("plain reply")]);
    try {
      const io = testIo(dir, { stdin: "hello\n/attachments\nmulti\\\nline\n" });
      assert.equal(await main(["chat", "--plain"], io), 0, io.stderr);
      assert.match(io.stdout, /plain reply/);
      assert.match(io.stdout, /nothing is staged/);
      assert.deepEqual((await entries(dir)).filter((e) => e.$tag === "user").map(userText), ["hello", "multi\nline"]);
      const bad = testIo(dir, { stdin: "/nonsense\n" });
      assert.equal(await main(["chat", "--plain"], bad), 1);
      assert.match(bad.stderr, /there is no command \/nonsense/);
    } finally {
      await server.close();
    }
  });
});
