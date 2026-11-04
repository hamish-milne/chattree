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

describe("automatic summaries", () => {
  const full = (threshold: number, keep = 2): string => `compaction:\n  auto: full\n  threshold_tokens: ${threshold}\n  keep_recent: ${keep}\n`;
  const long = (word: string, n = 750): string => `${word.padEnd(5)} `.repeat(n);
  const compactions = async (dir: string) => (await entries(dir)).filter((e) => e.$tag === "compaction");
  const requests = async (dir: string): Promise<number> => (await (await Conversation.open(host, dir)).ledger()).conversation.requests;

  test("a summary is written at the start of a turn, from what the model saw, counted in the ledger, and the request is then smaller", async () => {
    const { server, dir } = await started([answer("a1"), answer("The user sent a long message about alpha."), answer("a2")], full(6600, 1));
    try {
      const r = await session(dir, [long("alpha"), long("beta")]);
      assert.equal(r.code, 0, r.all);
      const [c] = await compactions(dir);
      assert.equal(c?.by, "auto");
      assert.equal(c?.model, "qwen3:4b");
      assert.ok(c?.usage !== undefined && (c.usage["input_tokens"] ?? 0) > 0, "its usage is recorded");
      assert.equal(await requests(dir), 3, "the ledger counts the summary as a request");
      const asked = JSON.parse(bodies(server)[1] as string) as { messages: { content: string }[] };
      assert.match(asked.messages.at(-1)?.content ?? "", /Summarise this part of a conversation[\s\S]*alpha alpha/);
      const last = bodies(server).at(-1) as string;
      assert.match(last, /The user sent a long message about alpha\./);
      assert.doesNotMatch(last, /alpha alpha/);
    } finally {
      await server.close();
    }
  });

  test("never in the middle of a tool loop: a long result there is left alone, and nothing is written", async () => {
    const { server, dir } = await started([callRun("c1", "cat big.txt"), answer("it is long")], full(5600));
    try {
      const r = await session(dir, ["show me big.txt"]);
      assert.equal(r.code, 0, r.all);
      assert.equal((await compactions(dir)).length, 0);
    } finally {
      await server.close();
    }
  });

  test("a summary that does not bring the request under the threshold is an error, it stays recorded, and the next request goes out without another", async () => {
    const { server, dir } = await started([answer("a1"), answer("a2"), answer("A short summary."), answer("fine, carrying on")], full(6600));
    try {
      const r = await session(dir, ["one", "two", long("alpha", 1250), "ok"]);
      assert.match(r.all, /did not bring the request under the threshold/);
      assert.equal((await compactions(dir)).length, 1);
      const sent = JSON.parse(bodies(server).at(-1) as string) as { messages: { content: string }[] };
      assert.match(sent.messages.at(-1)?.content ?? "", /\bok\b/, "the request went out");
      assert.equal((await compactions(dir)).length, 1, "no second summary within the cooldown");
    } finally {
      await server.close();
    }
  });

  test("an empty summary is refused and nothing is recorded", async () => {
    const { server, dir } = await started([answer("a1"), answer("  ")], full(6600, 1));
    try {
      const r = await session(dir, [long("alpha"), long("beta")]);
      assert.match(r.all, /returned an empty summary/);
      assert.equal((await compactions(dir)).length, 0);
    } finally {
      await server.close();
    }
  });

  test("with a threshold too low for anything to be summarised, it says what to change", async () => {
    const { server, dir } = await started([answer("a1")], full(50));
    try {
      const r = await session(dir, ["hello"]);
      assert.match(r.all, /nothing older than the last 2 entries can be summarised; lower compaction\.keep_recent/);
    } finally {
      await server.close();
    }
  });

  test("a request near the window that cannot be reduced is not sent", async () => {
    const models = '    models:\n      "qwen3:4b":\n        context_window: 8000\n';
    const { server, dir } = await started([answer("a1")], "compaction:\n  auto: trim\n  keep_recent: 2\n");
    const yml = await readFile(join(dir, "harness.yml"), "utf8");
    await writeFile(join(dir, "harness.yml"), yml.replace("    pricing: { free: true }\n", `    pricing: { free: true }\n${models}`));
    await approve(dir);
    try {
      const r = await session(dir, [long("alpha", 1000), long("beta", 1250)]);
      assert.match(r.all, /was not sent/);
      assert.equal(server.seen.length, 1, "only the first request went out");
    } finally {
      await server.close();
    }
  });

  test("near the threshold the model is told the context is filling up", async () => {
    const { server, dir } = await started([answer("a1"), answer("a2"), answer("a3")], full(8100));
    try {
      await session(dir, [long("alpha"), long("beta"), "ok"]);
      assert.match(bodies(server).at(-1) as string, /The context is filling up/);
      assert.doesNotMatch(bodies(server)[0] as string, /The context is filling up/);
    } finally {
      await server.close();
    }
  });

  for (const input of ["seen", "raw"] as const) {
    test(`summary_input: ${input} decides whether the summarizer reads the old tool output`, async () => {
      const { server, dir } = await started([callRun("c1", "cat big.txt"), answer("it is long"), answer("It was long."), answer("ok")], full(6600, 1).concat(`  summary_input: ${input}\n`));
      try {
        await session(dir, ["show me big.txt", long("beta", 1250)]);
        const asked = bodies(server)[2] as string;
        assert.match(asked, /Summarise this part of a conversation/);
        if (input === "raw") assert.match(asked, /a line of old output/);
        else {
          assert.doesNotMatch(asked, /a line of old output/);
          assert.match(asked, /of output of this call were left out/);
        }
      } finally {
        await server.close();
      }
    });
  }
});
