import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { Conversation } from "../../harness/conversation.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, chunk, host, initArgs, testIo, usageChunk } from "./support.ts";
import { approve } from "../support/trust.ts";

const callRun = (id: string, command: string): Reply => ({
  acts: [chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: "run", arguments: JSON.stringify({ command }) } }] }), chunk({}, "tool_calls"), usageChunk(30, 8), "data: [DONE]\n\n"],
});

async function started(replies: Reply[], config = "") {
  const server = await FakeServer.start(replies);
  const dir = join(await tempDir(), "p");
  assert.equal(await main(initArgs(server, dir), testIo(dir)), 0);
  await writeFile(join(dir, "big.txt"), "a line of old output\n".repeat(300));
  const yml = await readFile(join(dir, "harness.yml"), "utf8");
  await writeFile(join(dir, "harness.yml"), yml.replace("  run:\n", '  run:\n    allow: { "cat **": 2999-01-01 }\n'));
  if (config !== "") await appendFile(join(dir, "harness.yml"), `\n${config}`);
  await approve(dir);
  return { server, dir };
}
async function session(dir: string, lines: string[]) {
  const io = testIo(dir, { stdin: `${lines.join("\n")}\n` });
  const code = await main(["chat", "--plain", "-y"], io);
  return { code, all: `${io.stdout}${io.stderr}` };
}
const bodies = (server: FakeServer) => server.seen.map((s) => s.body);
const entries = async (dir: string) => (await (await Conversation.open(host, dir)).readEntries()).flatMap((e) => (e.ok ? [e.value] : []));

describe("/compact trim", () => {
  test("leaves old tool output out of what the model sees, keeps the recent entries, and the transcript keeps everything", async () => {
    const { server, dir } = await started([callRun("c1", "cat big.txt"), answer("it is long"), answer("noted")]);
    try {
      const r = await session(dir, ["show me big.txt", "/compact trim 1", "thanks"]);
      assert.equal(r.code, 0, r.all);
      assert.match(r.all, /trimmed: about \d+\.\d KB/);
      const seen = bodies(server);
      assert.match(seen[1] as string, /a line of old output/, "before the trim the model saw it");
      assert.doesNotMatch(seen[2] as string, /a line of old output/);
      assert.match(seen[2] as string, /of output of this call were left out/);
      assert.match(seen[2] as string, /show me big\.txt/, "the user's words stay");
      const all = await entries(dir);
      assert.ok(all.some((e) => e.$tag === "tool_result" && (typeof e.content === "string" ? e.content.length : e.content.bytes) > 6000), "the transcript still has the whole output (stored as a blob)");
      assert.equal(all.filter((e) => e.$tag === "trim").length, 1);
    } finally {
      await server.close();
    }
  });

  test("with nothing big enough before the recent entries it says so and writes nothing", async () => {
    const { server, dir } = await started([answer("hi")]);
    try {
      const r = await session(dir, ["hello", "/compact trim", "/compact trim x"]);
      assert.match(r.all, /nothing to trim before the last 12 entries/);
      assert.match(r.all, /give how many recent entries to keep whole/);
      assert.equal((await entries(dir)).filter((e) => e.$tag === "trim").length, 0);
    } finally {
      await server.close();
    }
  });
});

describe("automatic trimming", () => {
  const config = "compaction:\n  auto: trim\n  threshold_tokens: 50\n  keep_recent: 2\n";

  test("at the threshold a trim is recorded before the request, and the model is not shown the old output", async () => {
    const { server, dir } = await started([callRun("c1", "cat big.txt"), answer("it is long"), answer("noted")], config);
    try {
      const r = await session(dir, ["show me big.txt", "thanks"]);
      assert.equal(r.code, 0, r.all);
      const all = await entries(dir);
      const trims = all.filter((e) => e.$tag === "trim");
      assert.ok(trims.length >= 1 && trims.every((t) => t.by === "auto"), "recorded as automatic");
      assert.doesNotMatch(bodies(server).at(-1) as string, /a line of old output/);
      assert.match(bodies(server).at(-1) as string, /left out/);
    } finally {
      await server.close();
    }
  });

  test("it is off unless asked for", async () => {
    const { server, dir } = await started([callRun("c1", "cat big.txt"), answer("it is long"), answer("noted")], "compaction:\n  threshold_tokens: 50\n  keep_recent: 2\n");
    try {
      await session(dir, ["show me big.txt", "thanks"]);
      assert.equal((await entries(dir)).filter((e) => e.$tag === "trim").length, 0);
      assert.match(bodies(server).at(-1) as string, /a line of old output/);
    } finally {
      await server.close();
    }
  });
});
