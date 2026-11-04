import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { Conversation } from "../../harness/conversation.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, chunk, host, initArgs, testIo, usageChunk } from "./support.ts";

const SERVER = fileURLToPath(new URL("../support/mcp-server.ts", import.meta.url));

const callTool = (id: string, name: string, args: object): Reply => ({
  acts: [chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }), chunk({}, "tool_calls"), usageChunk(30, 8), "data: [DONE]\n\n"],
});

async function started(replies: Reply[], allow = false) {
  const server = await FakeServer.start(replies);
  const dir = join(await tempDir(), "p");
  assert.equal(await main(initArgs(server, dir), testIo(dir)), 0);
  await appendFile(join(dir, "harness.yml"), `\nmcp:\n  fake:\n    command: ${JSON.stringify(process.execPath)}\n    args: ["--no-warnings", ${JSON.stringify(SERVER)}]\n${allow ? "    allow: {all: 2999-01-01}\n" : ""}`);
  return { server, dir };
}
async function session(dir: string, lines: string[], opts: { yes?: boolean } = {}) {
  const io = testIo(dir, { stdin: `${lines.join("\n")}\n` });
  const code = await main(["chat", "--plain", ...(opts.yes === false ? [] : ["-y"])], io);
  return { code, out: io.stdout, err: io.stderr, all: `${io.stdout}${io.stderr}` };
}
const bodyOf = (server: FakeServer, n: number) => JSON.parse(server.seen[n]?.body ?? "") as { tools?: { function: { name: string } }[]; messages: { role: string; content: unknown }[] };

describe("MCP servers in a chat", () => {
  test("nothing starts until the thread accepts the server; then its tools are pinned, offered, and a call reaches it", async () => {
    const { server, dir } = await started([callTool("c1", "mcp__fake__echo", { text: "hello" }), answer("it said hello")], true);
    try {
      const r = await session(dir, ["/mcp", "/mcp accept fake", "/mcp", "/mcp show fake echo", "use the echo tool"]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.all, /fake {2}\[not accepted\]/);
      assert.match(r.all, /fake offers: change, echo, fail, picture, slow/);
      assert.match(r.all, /fake: tools pinned to this thread; each call still asks|fake: tools pinned to this thread/);
      assert.match(r.out, /fake {2}\[ready\] {2}fake 1\.2\.3 {2}5 tools/);
      assert.match(r.out, /mcp__fake__echo\n\[MCP server fake\] Repeat the text back\./);
      assert.ok(bodyOf(server, 0).tools?.some((t) => t.function.name === "mcp__fake__echo"), "offered to the model");
      assert.match(JSON.stringify(bodyOf(server, 1).messages), /echo: hello/, "the result went back to the model");
      const setup = await (await Conversation.open(host, dir)).setup();
      assert.ok(setup.mcp["fake"] !== undefined && setup.tools["mcp__fake__echo"] !== undefined);
    } finally {
      await server.close();
    }
  });

  test("without acceptance the server stays off, the thread still works, and a pinned tool that cannot be reached stops the loop with a pointer", async () => {
    const { server, dir } = await started([answer("plain")]);
    try {
      const r = await session(dir, ["hello"]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.all, /MCP server fake is not accepted by this thread/);
      assert.equal(bodyOf(server, 0).tools?.some((t) => t.function.name.startsWith("mcp__")) ?? false, false);
      await session(dir, ["/mcp accept fake"]);
      // The server's program goes away (a changed command line): the configuration no longer matches, so it is not started and its pinned tools are unreachable.
      await appendFile(join(dir, "harness.yml"), "");
      const text = await import("node:fs/promises").then((f) => f.readFile(join(dir, "harness.yml"), "utf8"));
      await import("node:fs/promises").then((f) => f.writeFile(join(dir, "harness.yml"), text.replace('"--no-warnings",', '"--no-warnings", "--check",')));
      const again = await session(dir, ["/mcp", "hello again"]);
      assert.match(again.all, /fake {2}\[configuration changed\]/);
      assert.match(again.all, /not what this thread accepted: \/mcp shows why/);
    } finally {
      await server.close();
    }
  });

  test("a call asks by default: with no one to ask it does not run", async () => {
    const { server, dir } = await started([callTool("c1", "mcp__fake__echo", { text: "hello" }), answer("ok")]);
    try {
      const r = await session(dir, ["/mcp accept fake", "use the echo tool"]);
      assert.equal(r.code, 0, r.err);
      assert.match(JSON.stringify(bodyOf(server, 1).messages), /declined to run this call/);
      assert.doesNotMatch(JSON.stringify(bodyOf(server, 1).messages), /echo: hello/);
    } finally {
      await server.close();
    }
  });

  test("declining the question accepts nothing", async () => {
    const { server, dir } = await started([]);
    try {
      const io = testIo(dir, { stdin: "/mcp accept fake\n/mcp\n" });
      assert.equal(await main(["chat", "--plain"], io), 0, io.stderr);
      assert.match(`${io.stdout}${io.stderr}`, /fake was not accepted/);
      assert.match(io.stdout, /fake {2}\[not accepted\]/);
      assert.deepEqual(Object.keys((await (await Conversation.open(host, dir)).setup()).mcp), []);
    } finally {
      await server.close();
    }
  });

  test("/mcp forget unpins the configuration and the tools", async () => {
    const { server, dir } = await started([]);
    try {
      await session(dir, ["/mcp accept fake"]);
      const r = await session(dir, ["/mcp forget fake"]);
      assert.match(r.all, /fake is forgotten/);
      const setup = await (await Conversation.open(host, dir)).setup();
      assert.deepEqual([Object.keys(setup.mcp), Object.keys(setup.tools).filter((n) => n.startsWith("mcp__"))], [[], []]);
    } finally {
      await server.close();
    }
  });
});
