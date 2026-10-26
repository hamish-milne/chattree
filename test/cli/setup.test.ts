import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import type { Io } from "../../cli/io.ts";
import { Conversation } from "../../harness/conversation.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, chunk, host, initArgs, testIo, usageChunk } from "./support.ts";

async function started(replies: Reply[]) {
  const server = await FakeServer.start(replies);
  const dir = join(await tempDir(), "p");
  const io = testIo(dir);
  assert.equal(await main(initArgs(server, dir), io), 0, io.stderr);
  return { server, dir };
}
async function session(dir: string, lines: string[], opts: { yes?: boolean; io?: Partial<Io> } = {}) {
  const io = testIo(dir, { stdin: `${lines.join("\n")}\n`, ...opts.io });
  const code = await main(["chat", "--plain", ...(opts.yes === false ? [] : ["-y"])], io);
  return { code, out: io.stdout, err: io.stderr, all: `${io.stdout}${io.stderr}` };
}
const sentSystem = (server: FakeServer, n: number): string => ((JSON.parse(server.seen[n]?.body ?? "") as { messages: { role: string; content: string }[] }).messages[0]?.content ?? "");

describe("model and settings", () => {
  test("/model shows the current model and what is available; a change is used by the next request", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      const r = await session(dir, ["/model", "/model other-model", "/model", "hello", "/model nope/x", "/model local/third", "/status"]);
      assert.match(r.out, /local\/qwen3:4b\nsettings: \{"max_output_tokens":256\}/);
      assert.match(r.out, /available:\n  local \(openai-compatible\)/);
      assert.match(r.all, /now using local\/other-model/);
      assert.equal((JSON.parse(server.seen[0]?.body ?? "") as { model: string }).model, "other-model");
      assert.match(r.err, /there is no provider nope in harness\.yml/);
      assert.match(r.out, /model:\s+local\/third\s+\{"max_output_tokens":256\}/, "settings stay within a provider");
    } finally {
      await server.close();
    }
  });

  test("/set shows, changes, unsets and refuses what the provider would refuse", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      const r = await session(dir, ["/set", "/set temperature 0.5", "/set temperature", "/set stop [\"END\"]", "/set bogus 1", "/set temperature 9", "/set temperature unset", "/set", "hello"]);
      assert.match(r.out, /"max_output_tokens": 256[\s\S]*settings openai-compatible accepts: max_output_tokens, temperature/);
      assert.match(r.all, /temperature set to 0\.5/);
      assert.match(r.out, /temperature: 0\.5/);
      assert.match(r.err, /that setting is not valid for local/);
      assert.match(r.err, /known keys: max_output_tokens/);
      assert.match(r.all, /temperature is unset/);
      const body = JSON.parse(server.seen[0]?.body ?? "") as Record<string, unknown>;
      assert.equal(body["temperature"], undefined);
      assert.deepEqual(body["stop"], ["END"]);
    } finally {
      await server.close();
    }
  });
});

describe("instructions", () => {
  test("set, show, and the model gets them; an unchanged or empty text is not recorded", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      const r = await session(dir, ["/instructions", "/instructions set Answer in one word.", "/instructions", "/instructions set Answer in one word.", "/instructions set", "hello"]);
      assert.match(r.out, /no instructions are set/);
      assert.match(r.out, /^Answer in one word\.$/m);
      assert.match(r.all, /the instructions are unchanged/);
      assert.match(r.err, /would be empty/);
      assert.match(sentSystem(server, 0), /Answer in one word\./);
    } finally {
      await server.close();
    }
  });

  test("/instructions edit hands the file to the editor and records what came back", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      let seen = "";
      const edit = async (path: string): Promise<boolean> => {
        seen = await readFile(path, "utf8");
        await writeFile(path, "Be terse.\nNo lists.\n");
        return true;
      };
      const r = await session(dir, ["/instructions set first version", "/instructions edit", "hello"], { io: { edit } });
      assert.equal(seen, "first version", "the editor opened on the current text");
      assert.match(r.all, /instructions updated/);
      assert.match(sentSystem(server, 0), /Be terse\.\nNo lists\./);
      const failing = await session(dir, ["/instructions edit"], { io: { edit: async () => false } });
      assert.match(failing.err, /did not exit cleanly/);
      const none = await session(dir, ["/instructions edit"]);
      assert.match(none.err, /there is no editor here/);
    } finally {
      await server.close();
    }
  });
});

describe("providers, prices, config", () => {
  test("/providers lists them with their key state; /pricing shows and pins; /config validates and reloads after an edit", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      const r = await session(dir, ["/providers", "/pricing", "/pricing pin", "/pricing bogus", "/config"]);
      assert.match(r.out, /\* local  openai-compatible  http:\/\/127\.0\.0\.1:\d+\/v1  no key needed/);
      assert.match(r.out, /pinned:\s+[0-9a-f]{12}\nin force:\s+[0-9a-f]{12}\nthe pin is current/);
      assert.match(r.all, /the current prices are already pinned/);
      assert.match(r.err, /unknown option bogus/);
      assert.match(r.out, /valid\nproviders:\s+local\nlimits:/);
      const edit = async (path: string): Promise<boolean> => {
        await writeFile(path, (await readFile(path, "utf8")).replace("max_turn_usd: 5", "max_turn_usd: 7"));
        return true;
      };
      const e = await session(dir, ["/config edit"], { io: { edit } });
      assert.match(e.all, /reloaded/);
      assert.match(e.out, /"max_turn_usd":7/);
      const broken = await session(dir, ["/config edit"], { io: { edit: async (p) => (await writeFile(p, "providers: {x: {$tag: nonsense}}\n"), true) } });
      assert.match(broken.err, /harness\.yml has problems/);
      await writeFile(join(dir, "harness.yml"), "providers: 5\n");
      const bad = await session(dir, ["/providers"]);
      assert.notEqual(bad.code, 0);
    } finally {
      await server.close();
    }
  });
});

describe("accepting provider changes", () => {
  test("a model alias that moves to a new version is held until /accept", async () => {
    const served = (text: string, model: string): Reply => ({ acts: [`data: ${JSON.stringify({ id: "c", model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`, chunk({}, "stop"), usageChunk(10, 2), "data: [DONE]\n\n"] });
    const { server, dir } = await started([served("first", "qwen3:4b-2026-10"), served("second", "qwen3:4b-2026-11"), answer("third")]);
    try {
      assert.equal((await session(dir, ["one"], { yes: false })).code, 0, "the first sighting of the dated model is just recorded");
      assert.equal((await session(dir, ["two"], { yes: false })).code, 0, "the answer that reveals the change is kept");
      const c = await Conversation.open(host, dir);
      assert.equal((await c.setup()).unacknowledged.length, 1);
      const held = await session(dir, ["three"], { yes: false });
      assert.notEqual(held.code, 0);
      assert.match(held.err, /resolved_model_changed: the provider changed the agent/);
      assert.match(held.err, /\/accept accepts a change/);
      assert.equal(server.seen.length, 2, "nothing was sent");
      const r = await session(dir, ["/accept", "/accept", "/retry"], { yes: false });
      assert.match(r.all, /accepting .*resolved_model_changed/);
      assert.match(r.all, /accepted; requests can go ahead/);
      assert.match(r.all, /nothing to accept/);
      assert.equal(r.code, 0, r.err);
      assert.equal(server.seen.length, 3);
    } finally {
      await server.close();
    }
  });
});
