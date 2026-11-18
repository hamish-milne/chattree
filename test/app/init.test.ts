import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { runInit } from "../../app/init.ts";
import { Conversation, NoModelPinned } from "../../harness/conversation.ts";
import { prepareContext } from "../../harness/request.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const envFor = async (dir: string) => ({
  host,
  cwd: dir,
  // The settings file goes under a temporary directory, never the person's own.
  env: { CHATTREE_SETTINGS: join(dir, "settings", "settings.yml") },
  now: Date.now,
});

describe("starting a conversation without a provider", () => {
  test("init with provider none makes the conversation and a config with no providers, and pins nothing", async () => {
    const dir = await tempDir();
    const env = await envFor(dir);
    const r = await runInit(env, { dir: join(dir, "p"), provider: "none" });
    assert.equal(r.provider, undefined);
    assert.equal(r.model, undefined);
    assert.equal(r.pinned, false);
    assert.match(r.notes.join("\n"), /no provider yet/);
    const convo = await Conversation.open(host, join(dir, "p"));
    assert.equal((await convo.setup()).model, undefined);
    const config = await convo.readConfig();
    assert.deepEqual(Object.keys(config?.ok === true ? config.value.providers : { x: 1 }), []);
  });

  test("what needs a model refuses with NoModelPinned, and says what to do", async () => {
    const dir = await tempDir();
    await runInit(await envFor(dir), { dir: join(dir, "p"), provider: "none" });
    const convo = await Conversation.open(host, join(dir, "p"));
    const refused = (e: unknown): boolean => e instanceof NoModelPinned && /add a provider and choose a model/.test(e.message);
    await assert.rejects(prepareContext(convo, { system: "s" }), refused);
    await assert.rejects(convo.pinPricing(), refused);
  });

  test("a fork of a conversation with no model is fine, and still has none", async () => {
    const dir = await tempDir();
    await runInit(await envFor(dir), { dir: join(dir, "p"), provider: "none" });
    const convo = await Conversation.open(host, join(dir, "p"));
    const fork = await convo.fork(undefined, { name: "idea" });
    assert.ok(fork.conversation);
    assert.equal((await fork.conversation.setup()).model, undefined);
  });

  test("adopting a repository works the same way", async () => {
    const dir = await tempDir();
    const env = await envFor(dir);
    const { Git } = await import("../../src/index.ts");
    const repo = join(dir, "existing");
    const git = await Git.init(host, repo, { branch: "trunk" });
    await git.setConfig("user.name", "T");
    await git.setConfig("user.email", "t@example.com");
    await host.fs.writeAtomic(join(repo, "README.md"), new TextEncoder().encode("# hi\n"));
    await git.run(["add", "."]);
    await git.run(["commit", "-m", "first"]);
    const r = await runInit(env, { dir: repo, provider: "none", adopt: true });
    assert.equal(r.branch, "trunk");
    assert.equal((await (await Conversation.open(host, repo)).setup()).model, undefined);
  });
});
