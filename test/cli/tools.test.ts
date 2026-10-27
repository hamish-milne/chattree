import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { buildToolSet } from "../../cli/toolset.ts";
import { Conversation } from "../../harness/conversation.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, chunk, host, initArgs, testIo, usageChunk } from "./support.ts";

const ESC = String.fromCharCode(27);
const strip = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "").replace(/\r/g, "");

/** A streamed reply in which the model asks for tools. */
const callTools = (...calls: { id: string; name: string; args: object }[]): Reply => ({
  acts: [
    ...calls.map((c, i) => chunk({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] })),
    chunk({}, "tool_calls"),
    usageChunk(30, 8),
    "data: [DONE]\n\n",
  ],
});

async function waitFor(pred: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function started(replies: Reply[], files: Record<string, string> = {}) {
  const server = await FakeServer.start(replies);
  const dir = join(await tempDir(), "p");
  const io = testIo(dir);
  assert.equal(await main(initArgs(server, dir), io), 0, io.stderr);
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return { server, dir };
}

const entries = async (dir: string) => (await (await Conversation.open(host, dir)).readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
const toolResults = async (dir: string) => (await entries(dir)).flatMap((e) => (e.$tag === "tool_result" ? [e] : []));
const text = (c: unknown): string => (typeof c === "string" ? c : "");

function terminal(dir: string, over: Parameters<typeof testIo>[1] = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = "";
  output.on("data", (d: Buffer) => void (raw += d.toString()));
  const io = testIo(dir, { interactive: true, tty: { input, output }, env: { PATH: process.env["PATH"] }, ...over });
  const done = main(["chat", "--thread", "main"], io);
  return { io, type: (s: string) => void input.write(s), screen: () => strip(raw + io.stdout + io.stderr), done, end: () => void input.end() };
}

describe("/retry at a tool call", () => {
  test("an assistant turn that ended on tool calls nothing answered can be retried", async () => {
    const { server, dir } = await started([callTools({ id: "c1", name: "read", args: { path: "a.txt" } }), answer("carried on")]);
    try {
      assert.equal(await main(["say", "look at a.txt"], testIo(dir)), 0);
      assert.equal((await entries(dir)).at(-1)?.$tag, "assistant");
      const again = testIo(dir);
      assert.equal(await main(["retry"], again), 0, again.stderr);
      assert.equal((await entries(dir)).at(-1)?.$tag, "assistant");
      assert.equal(again.stdout, "carried on\n");
    } finally {
      await server.close();
    }
  });
});

describe("tools in a plain chat", () => {
  test("a call the starting grants cover runs, and is shown as a start line and a result line", async () => {
    const { server, dir } = await started([callTools({ id: "c1", name: "read", args: { path: "hello.txt" } }), answer("It says hello.")], { "hello.txt": "hello world\n" });
    try {
      const io = testIo(dir, { stdin: "what does hello.txt say?\n" });
      assert.equal(await main(["chat", "--plain"], io), 0, io.stderr);
      assert.match(io.stderr, /→ read hello\.txt/);
      assert.match(io.stderr, /← ok · /);
      assert.match(io.stdout, /It says hello\./);
      const [r] = await toolResults(dir);
      assert.match(text(r!.content), /hello world/);
      assert.equal(server.seen.length, 2);
      assert.match(server.seen[1]!.body, /hello world/, "the result went back to the model");
    } finally {
      await server.close();
    }
  });

  test("a call no grant covers is declined when nobody can be asked, and the model is told", async () => {
    const { server, dir } = await started([callTools({ id: "c1", name: "run", args: { command: "echo hi > out.txt" } }), answer("I could not run it.")]);
    try {
      const io = testIo(dir, { stdin: "run it\n" });
      await main(["chat", "--plain"], io);
      const [r] = await toolResults(dir);
      assert.equal(r!.is_error, true);
      assert.match(text(r!.content), /needs the user's approval/);
      await assert.rejects(readFile(join(dir, "out.txt")), /ENOENT/, "it did not run");
      assert.match(io.stderr, /← failed/);
    } finally {
      await server.close();
    }
  });

  test("a key written by hand in harness.yml covers the command", async () => {
    const { server, dir } = await started([callTools({ id: "c1", name: "run", args: { command: "cat hello.txt" } }), answer("done")], { "hello.txt": "hello world\n" });
    try {
      const yml = await readFile(join(dir, "harness.yml"), "utf8");
      await writeFile(join(dir, "harness.yml"), yml.replace("  run:\n", '  run:\n    allow: { "cat **": 2999-01-01 }\n'));
      const io = testIo(dir, { stdin: "cat it\n" });
      await main(["chat", "--plain"], io);
      const [r] = await toolResults(dir);
      assert.equal(r!.is_error, false);
      assert.match(text(r!.content), /hello world/);
    } finally {
      await server.close();
    }
  });

  test("/tools lists what is allowed; /tools <name> allow adds a key and revoke removes it; /expand shows a whole result", async () => {
    const { server, dir } = await started([callTools({ id: "c1", name: "read", args: { path: "hello.txt" } }), answer("ok")], { "hello.txt": "one\ntwo\nthree\nfour\nfive\n" });
    try {
      const io = testIo(dir, { stdin: "read\n/tools\n/tools run allow 'cat **' 1h\n/tools\n/tools run revoke\n/tools run allow 'xargs **'\n/expand\n/jobs\n" });
      await main(["chat", "--plain"], io);
      assert.match(io.stdout, /read\s+everything until 2999-01-01/);
      assert.match(io.stdout, /run\s+asks every time/);
      assert.match(io.stdout, /run\s+cat \*\* until \d{4}-\d\d-\d\dT/);
      assert.match(io.stderr, /run: cat \*\* allowed until/);
      assert.match(io.stderr, /run: every grant removed/);
      assert.match(io.stderr, /error: xargs runs other programs/);
      assert.match(io.stdout, /five/, "/expand shows the whole result");
      assert.match(io.stdout, /no background jobs/);
      const yml = await readFile(join(dir, "harness.yml"), "utf8");
      assert.doesNotMatch(yml, /cat \*\*/);
    } finally {
      await server.close();
    }
  });
});

describe("approvals in the terminal", () => {
  test("yes once runs the call and stores nothing; forever stores an exact key in its own commit", async () => {
    const { server, dir } = await started([
      callTools({ id: "c1", name: "run", args: { command: "echo first" } }),
      callTools({ id: "c2", name: "run", args: { command: "echo second" } }),
      answer("all done"),
    ]);
    const t = terminal(dir);
    try {
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type("go\n\n");
      await waitFor(() => t.screen().includes("Allow this?") && t.screen().includes("echo first"), "the first question");
      assert.match(t.screen(), /\[y\] yes, once\s+\[5\] 5 minutes\s+\[h\] 1 hour\s+\[f\] forever/);
      t.type("y\n");
      await waitFor(() => (t.screen().match(/Allow this\?/g) ?? []).length === 2, "the second question");
      t.type("f\n");
      await waitFor(() => t.screen().includes("all done"), "the final reply");
      t.type("/quit\n");
      await t.done;
      const rs = await toolResults(dir);
      assert.deepEqual(rs.map((r) => r.is_error), [false, false]);
      assert.match(text(rs[0]!.content), /first/);
      const yml = await readFile(join(dir, "harness.yml"), "utf8");
      assert.match(yml, /echo second: 2999-01-01/);
      assert.doesNotMatch(yml, /echo first/);
      const conv = await Conversation.open(host, dir);
      const log = new TextDecoder().decode((await conv.git.run(["log", "--format=%s", "-n", "30"])).stdout);
      assert.match(log, /approvals: allow run: echo second until 2999-01-01/);
    } finally {
      t.end();
      await server.close();
    }
  });

  test("no sends the reason to the model, and the command does not run", async () => {
    const { server, dir } = await started([callTools({ id: "c1", name: "run", args: { command: "echo nope > out.txt" } }), answer("understood")]);
    const t = terminal(dir);
    try {
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type("go\n\n");
      await waitFor(() => t.screen().includes("Allow this?"), "the question");
      t.type("n\n");
      await waitFor(() => t.screen().includes("Why not?"), "the reason prompt");
      t.type("not in this directory\n");
      await waitFor(() => t.screen().includes("understood"), "the reply");
      t.type("/quit\n");
      await t.done;
      const [r] = await toolResults(dir);
      assert.match(text(r!.content), /declined.*not in this directory/);
      await assert.rejects(readFile(join(dir, "out.txt")), /ENOENT/);
    } finally {
      t.end();
      await server.close();
    }
  });

  test("a script is shown whole before it can be allowed, and offers no longer grant", async () => {
    const { server, dir } = await started([callTools({ id: "c1", name: "script", args: { script: "echo one\necho two" } }), answer("ok")]);
    const t = terminal(dir);
    try {
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type("go\n\n");
      await waitFor(() => t.screen().includes("Allow this?"), "the question");
      assert.match(t.screen(), /echo one\s+echo two/);
      assert.doesNotMatch(t.screen(), /\[5\] 5 minutes/);
      t.type("y\n");
      await waitFor(() => t.screen().includes("ok"), "the reply");
      t.type("/quit\n");
      await t.done;
      assert.doesNotMatch(await readFile(join(dir, "harness.yml"), "utf8"), /script:\s*\n\s+allow: \{ *[^}\s]/);
    } finally {
      t.end();
      await server.close();
    }
  });
});

describe("questions from commands in a terminal", () => {
  test("/undo asks through the terminal's own prompt, and the prompt works afterwards", async () => {
    const { server, dir } = await started([answer("hi")]);
    // A second prompt on the same keyboard is what left the session stuck, so one here would fail the test.
    const t = terminal(dir, { ask: async () => { throw new Error("a second prompt was opened"); } });
    try {
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type("hello\n\n");
      await waitFor(() => t.screen().includes("hi"), "the reply");
      t.type("/undo\n");
      await waitFor(() => t.screen().includes("Go back? [y/N]"), "the question");
      t.type("y\n");
      await waitFor(() => t.screen().includes("done."), "the undo");
      t.type("/drafts\n");
      await waitFor(() => t.screen().includes("no named drafts"), "the next command");
      t.type("/quit\n");
      await t.done;
    } finally {
      t.end();
      await server.close();
    }
  });
});

describe("which tools are offered", () => {
  test("init lists every built-in tool, and a tool taken out of harness.yml is not offered", async () => {
    const { server, dir } = await started([]);
    try {
      const names = async () => {
        const set = await buildToolSet(testIo(dir), await Conversation.open(host, dir), { busy: () => false, onCommitted: () => undefined, onResume: () => undefined });
        return set.registry.definitions().map((d) => d.name).sort();
      };
      assert.deepEqual(await names(), ["edit", "job_output", "job_stop", "jobs", "read", "run", "script", "write"]);
      const yml = join(dir, "harness.yml");
      await writeFile(yml, (await readFile(yml, "utf8")).replace(/ {2}script:\n {4}allow: \{\}\n/, "").replace(/ {2}write:\n {4}allow: \{ all: 2999-01-01 \}\n/, ""));
      assert.deepEqual(await names(), ["edit", "job_output", "job_stop", "jobs", "read", "run"]);
    } finally {
      await server.close();
    }
  });
});

describe("init on Windows", () => {
  test("lists tools.run.batch: true only when the host is Windows, and the file still parses", async () => {
    const server = await FakeServer.start([]);
    try {
      const base = await tempDir();
      const win = join(base, "win");
      const w = testIo(win);
      assert.equal(await main(initArgs(server, win), { ...w, host: { ...w.host, platform: "windows" as const } }), 0, w.stderr);
      assert.match(await readFile(join(win, "harness.yml"), "utf8"), /^ {4}batch: true$/m);
      const posix = join(base, "posix");
      assert.equal(await main(initArgs(server, posix), testIo(posix)), 0);
      assert.doesNotMatch(await readFile(join(posix, "harness.yml"), "utf8"), /batch:/);
      const cfg = await (await Conversation.open(host, win)).readConfig();
      assert.equal(cfg?.ok === true && cfg.value.tools["run"]?.batch, true);
    } finally {
      await server.close();
    }
  });
});

describe("stopping at a question", () => {
  test("Ctrl-C while a question is open declines the call and ends the turn", async () => {
    const { server, dir } = await started([callTools({ id: "c1", name: "run", args: { command: "echo hi > out.txt" } }), answer("never")]);
    const t = terminal(dir);
    try {
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type("go\n\n");
      await waitFor(() => t.screen().includes("Allow this?"), "the question");
      t.type("\x03");
      await waitFor(async () => (await toolResults(dir)).length === 1, "the declined result");
      assert.equal(server.seen.length, 1, "no second request");
      await assert.rejects(readFile(join(dir, "out.txt")), /ENOENT/);
      t.type("/quit\n");
      await t.done;
    } finally {
      t.end();
      await server.close();
    }
  });
});

describe("background jobs in a session", () => {
  test("a job the model starts is reported when it ends, committed, and read by job_output", async () => {
    const js = `setTimeout(() => console.log("job output here"), 300)`;
    const { server, dir } = await started([
      callTools({ id: "c1", name: "run", args: { command: `${process.execPath} -e '${js}'`, background: true } }),
      answer("started it"),
      callTools({ id: "c2", name: "job_output", args: { job: "j1" } }),
      answer("it printed the line"),
    ]);
    const yml = await readFile(join(dir, "harness.yml"), "utf8");
    await writeFile(join(dir, "harness.yml"), yml.replace("  run:\n", `  run:\n    allow: { "${process.execPath.replaceAll("\\", "/")} **": 2999-01-01 }\n`));
    const t = terminal(dir);
    try {
      await waitFor(() => t.screen().includes("Ctrl-D leaves"), "the prompt");
      t.type("start it\n\n");
      await waitFor(() => t.screen().includes("started it"), "the first reply");
      await waitFor(() => t.screen().includes("background job j1 completed"), "the job notice");
      assert.ok((await entries(dir)).some((e) => e.$tag === "job_event" && e.job === "j1" && e.status === "completed"));
      t.type("what did it print?\n\n");
      await waitFor(() => t.screen().includes("it printed the line"), "the second reply");
      t.type("/quit\n");
      await t.done;
      const last = server.seen.at(-1)!.body;
      assert.match(last, /Background job j1 completed/);
      assert.match(last, /job output here/);
    } finally {
      t.end();
      await server.close();
    }
  });
});
