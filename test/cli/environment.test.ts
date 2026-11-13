import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { Conversation } from "../../harness/conversation.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, host, initArgs, testIo } from "./support.ts";
import { approve } from "../support/trust.ts";

async function started(replies: Reply[], config = "") {
  const server = await FakeServer.start(replies);
  const dir = join(await tempDir(), "p");
  assert.equal(await main(initArgs(server, dir), testIo(dir)), 0);
  if (config !== "") await appendFile(join(dir, "harness.yml"), `\n${config}`);
  await approve(dir);
  return { server, dir };
}
const session = async (dir: string, lines: string[], env: Record<string, string> = {}) => {
  const io = testIo(dir, { stdin: `${lines.join("\n")}\n`, env });
  const code = await main(["chat", "--plain", "-y"], io);
  return { code, all: `${io.stdout}${io.stderr}` };
};
const messages = (server: FakeServer, n: number) => (JSON.parse(server.seen[n]?.body ?? "") as { messages: { role: string; content: string }[] }).messages;

describe("the environment note in a chat", () => {
  test("the system prompt describes chattree, and the first request carries the note once, recorded in the transcript", async () => {
    const { server, dir } = await started([answer("a1"), answer("a2")]);
    try {
      const r = await session(dir, ["hello", "again"]);
      assert.equal(r.code, 0, r.all);
      const first = messages(server, 0);
      assert.match(first[0]?.content ?? "", /working in chattree[\s\S]*version 2\)$/);
      const user = first.find((m) => m.role === "user")?.content ?? "";
      assert.match(user, /\[Note from the harness\]\nEnvironment: .*Time zone .*today is /);
      assert.match(user, /Thread: main\. Workspace: /);
      assert.doesNotMatch(JSON.stringify(messages(server, 1).slice(2)), /Environment:/, "not repeated on the next request");
      const entries = (await (await Conversation.open(host, dir)).readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
      assert.equal(entries.filter((e) => e.$tag === "injection" && e.key === "environment").length, 1);
    } finally {
      await server.close();
    }
  });

  test("injections.environment: false leaves it out", async () => {
    const { server, dir } = await started([answer("a1")], "injections:\n  environment: false\n");
    try {
      await session(dir, ["hello"]);
      assert.doesNotMatch(JSON.stringify(messages(server, 0)), /Environment:/);
    } finally {
      await server.close();
    }
  });

  test("a fork says its own thread name", async () => {
    const { server, dir } = await started([answer("a1"), answer("a2")]);
    try {
      await session(dir, ["hello", "/fork side", "in the fork"]);
      const last = JSON.stringify(messages(server, 1));
      assert.match(last, /Thread: side\./);
    } finally {
      await server.close();
    }
  });
});
