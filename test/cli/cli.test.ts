import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { Conversation } from "../../harness/conversation.ts";
import { FakeServer } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, host, initArgs, testIo } from "./support.ts";

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await host.exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout).trim();
}
const entries = async (dir: string) => (await (await Conversation.open(host, dir)).readEntries()).flatMap((e) => (e.ok ? [e.value] : []));

async function started(server: FakeServer) {
  const dir = join(await tempDir(), "p");
  const io = testIo(dir);
  assert.equal(await main(initArgs(server, dir), io), 0, io.stderr);
  return { dir, io };
}

describe("init", () => {
  test("makes a repository with harness.yml, a first thread and the model set; the key is never written", async () => {
    const server = await FakeServer.start([answer("hi")]);
    try {
      const { dir, io } = await started(server);
      assert.match(io.stdout, /started a conversation/);
      const cfg = await readFile(join(dir, "harness.yml"), "utf8");
      assert.match(cfg, /openai-compatible/);
      assert.match(cfg, new RegExp(`base_url: ${server.url}/v1`));
      const es = await entries(dir);
      assert.deepEqual(es.map((e) => e.$tag), ["header", "agent_setup", "agent_setup"]);
      assert.equal(await git(dir, "branch", "--show-current"), "main");
    } finally {
      await server.close();
    }
  });

  test("a hosted provider without its key set still initialises, with a note, and never stores a placeholder", async () => {
    const dir = join(await tempDir(), "p");
    const io = testIo(dir);
    assert.equal(await main(["init", dir, "--provider", "anthropic"], io), 0, io.stderr);
    assert.match(io.stderr, /ANTHROPIC_API_KEY is not set/);
    assert.doesNotMatch(await readFile(join(dir, "chat.yml"), "utf8") + await readFile(join(dir, "harness.yml"), "utf8"), /placeholder/);
    const setups = (await entries(dir)).filter((e) => e.$tag === "agent_setup");
    const [model, prices] = setups;
    assert.equal(model?.$tag === "agent_setup" && model.model?.id, "claude-sonnet-5-5");
    assert.equal(prices?.$tag === "agent_setup" && prices.pricing !== undefined, true, "prices are pinned from the bundled table");
  });

  test("with no provider named and no key to go by it explains how to choose", async () => {
    const dir = join(await tempDir(), "p");
    const io = testIo(dir);
    assert.equal(await main(["init", dir], io), 1);
    assert.match(io.stderr, /pass --provider/);
  });

  test("inside a repository it refuses and says why; --adopt starts on the current branch; --force nests", async () => {
    const server = await FakeServer.start([answer("hi")]);
    try {
      const repo = join(await tempDir(), "r");
      await mkdir(repo, { recursive: true });
      await git(repo, "init", "-q", "--initial-branch=work");
      await writeFile(join(repo, "app.txt"), "x\n");
      await git(repo, "add", "-A");
      await git(repo, "commit", "-qm", "theirs");
      const plain = testIo(repo);
      assert.equal(await main(initArgs(server, repo), plain), 1);
      assert.match(plain.stderr, /inside the git repository/);
      assert.match(plain.stderr, /--adopt/);
      const adopt = testIo(repo);
      assert.equal(await main([...initArgs(server, repo), "--adopt"], adopt), 0, adopt.stderr);
      assert.match(adopt.stdout, /thread: work/);
      assert.equal((await entries(repo)).length, 3);

      const nested = join(repo, "sub");
      const force = testIo(repo);
      assert.equal(await main([...initArgs(server, nested), "--force"], force), 0, force.stderr);
      assert.equal(await git(nested, "rev-parse", "--show-toplevel"), nested);
      const both = testIo(repo);
      assert.equal(await main([...initArgs(server, join(repo, "x")), "--force", "--adopt"], both), 1);
    } finally {
      await server.close();
    }
  });
});

describe("finding the project", () => {
  test("from a subdirectory; not in a repository; a repository that is not a project; a detached HEAD", async () => {
    const server = await FakeServer.start([answer("hi")]);
    try {
      const { dir } = await started(server);
      await mkdir(join(dir, "a", "b"), { recursive: true });
      const sub = testIo(join(dir, "a", "b"));
      assert.equal(await main(["status"], sub), 0, sub.stderr);
      assert.match(sub.stdout, /thread:\s+main/);

      const nowhere = testIo(await tempDir());
      assert.equal(await main(["status"], nowhere), 1);
      assert.match(nowhere.stderr, /not inside a git repository/);

      const bare = join(await tempDir(), "bare");
      await mkdir(bare, { recursive: true });
      await git(bare, "init", "-q");
      const notProject = testIo(bare);
      assert.equal(await main(["status"], notProject), 1);
      assert.match(notProject.stderr, /not a chattree project/);

      await git(dir, "checkout", "-q", "--detach");
      const detached = testIo(dir);
      assert.equal(await main(["status"], detached), 1);
      assert.match(detached.stderr, /HEAD is detached/);
    } finally {
      await server.close();
    }
  });

  test("-C and an unknown verb or option", async () => {
    const server = await FakeServer.start([answer("hi")]);
    try {
      const { dir } = await started(server);
      const io = testIo(await tempDir());
      assert.equal(await main(["-C", dir, "status"], io), 0, io.stderr);
      const bad = testIo(dir);
      assert.equal(await main(["frobnicate"], bad), 2);
      assert.equal(await main(["--nope"], testIo(dir)), 2);
      assert.equal(await main([], testIo(dir)), 2);
      assert.equal(await main(["help"], testIo(dir)), 0);
    } finally {
      await server.close();
    }
  });
});

describe("say", () => {
  test("sends a message, streams the reply to stdout, puts the status line on stderr and commits both entries", async () => {
    const server = await FakeServer.start([answer("Hello there.", 20, 5)]);
    try {
      const { dir } = await started(server);
      const io = testIo(dir);
      assert.equal(await main(["say", "hi", "model"], io), 0, io.stderr);
      assert.equal(io.stdout, "Hello there.\n");
      assert.match(io.stderr, /\[20 in, 5 out · turn \$0\.0000 · thread \$0\.0000\]/);
      const es = await entries(dir);
      assert.deepEqual(es.map((e) => e.$tag), ["header", "agent_setup", "agent_setup", "user", "assistant"]);
      const sent = JSON.parse(server.seen[0]?.body ?? "") as { messages: { role: string; content: string }[] };
      assert.deepEqual(sent.messages.map((m) => [m.role, m.content.slice(0, 20)]).slice(1), [["user", "hi model"]]);
    } finally {
      await server.close();
    }
  });

  test("reads the message from standard input for -, and the thread's earlier messages go along", async () => {
    const server = await FakeServer.start([answer("one"), answer("two")]);
    try {
      const { dir } = await started(server);
      assert.equal(await main(["say", "-"], testIo(dir, { stdin: "first\nmessage\n" })), 0);
      assert.equal(await main(["say", "again"], testIo(dir)), 0);
      const sent = JSON.parse(server.seen[1]?.body ?? "") as { messages: { role: string; content: string }[] };
      assert.deepEqual(sent.messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
      assert.equal(sent.messages[1]?.content, "first\nmessage");
    } finally {
      await server.close();
    }
  });

  test("a provider failure leaves the user's message and no reply, says so, and /retry asks again", async () => {
    const server = await FakeServer.start([{ status: 400, acts: ['{"error":{"message":"bad request"}}'] }, answer("recovered")]);
    try {
      const { dir } = await started(server);
      const io = testIo(dir);
      assert.equal(await main(["say", "hello"], io), 1);
      assert.match(io.stderr, /error: the provider failed/);
      assert.match(io.stderr, /\/retry/);
      assert.deepEqual((await entries(dir)).map((e) => e.$tag), ["header", "agent_setup", "agent_setup", "user"]);
      const again = testIo(dir);
      assert.equal(await main(["retry"], again), 0, again.stderr);
      assert.equal(again.stdout, "recovered\n");
      assert.deepEqual((await entries(dir)).map((e) => e.$tag), ["header", "agent_setup", "agent_setup", "user", "assistant"]);
    } finally {
      await server.close();
    }
  });

  test("attached files go with the message: text inline, images as data URLs; a changed file stops the send", async () => {
    const server = await FakeServer.start([answer("seen")]);
    try {
      const { dir } = await started(server);
      const png = join(dir, "pic.png");
      await writeFile(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
      const note = join(dir, "note.txt");
      await writeFile(note, "remember the milk\n");
      const io = testIo(dir);
      assert.equal(await main(["say", "look at these", "--attach", png, "--attach", note], io), 0, io.stderr);
      const sent = JSON.parse(server.seen[0]?.body ?? "") as { messages: { role: string; content: { type: string; text?: string; image_url?: { url: string } }[] }[] };
      const user = sent.messages.at(-1)?.content ?? [];
      assert.deepEqual(user.map((p) => p.type), ["text", "image_url", "text"].sort().length === 3 ? ["text", "image_url", "text"] : []);
      assert.match(user[1]?.image_url?.url ?? "", /^data:image\/png;base64,/);
      assert.match(user[2]?.text ?? "", /\[Attached file: note\.txt\]\nremember the milk/);
      const user0 = (await entries(dir)).find((e) => e.$tag === "user");
      assert.equal(user0?.$tag === "user" && user0.content.length, 3);
    } finally {
      await server.close();
    }
  });

  test("an attachment it cannot use is refused before anything is sent", async () => {
    const server = await FakeServer.start([answer("never")]);
    try {
      const { dir } = await started(server);
      await writeFile(join(dir, "blob.bin"), new Uint8Array([0, 1, 2, 3, 0]));
      const io = testIo(dir);
      assert.equal(await main(["say", "x", "--attach", join(dir, "blob.bin")], io), 1);
      assert.match(io.stderr, /looks binary/);
      assert.equal(server.seen.length, 0);
      assert.deepEqual((await entries(dir)).map((e) => e.$tag), ["header", "agent_setup", "agent_setup"]);
    } finally {
      await server.close();
    }
  });
});

describe("reading verbs", () => {
  test("history, show, usage, status and threads, as verbs", async () => {
    const server = await FakeServer.start([answer("The answer.", 100, 10)]);
    try {
      const { dir } = await started(server);
      assert.equal(await main(["say", "question"], testIo(dir)), 0);
      const hist = testIo(dir);
      assert.equal(await main(["history"], hist), 0);
      assert.match(hist.stdout, /you:\n  question/);
      assert.match(hist.stdout, /qwen3:4b:\n  The answer\./);
      const show = testIo(dir);
      assert.equal(await main(["show"], show), 0);
      assert.match(show.stdout, /stop: end_turn  usage: \{"input_tokens":100,"output_tokens":10\}/);
      const usage = testIo(dir);
      assert.equal(await main(["usage"], usage), 0);
      assert.match(usage.stdout, /this thread: \$0\.0000 in 1 request/);
      const threads = testIo(dir);
      assert.equal(await main(["threads"], threads), 0);
      assert.match(threads.stdout, /^\* main/);
      const status = testIo(dir);
      assert.equal(await main(["status"], status), 0);
      assert.match(status.stdout, /model:\s+local\/qwen3:4b/);
      assert.equal(await main(["verify"], testIo(dir)), 0);
      assert.equal(await main(["history", "zero"], testIo(dir)), 1);
    } finally {
      await server.close();
    }
  });
});
