import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runInit } from "../../app/init.ts";
import { Conversation } from "../../harness/conversation.ts";
import { nodeHost } from "../../hosts/node.ts";
import { Controller } from "../../ui/controller/controller.ts";
import { parseEvent, type UiEvent } from "../../ui/model/protocol.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();

async function rig(extraEnv: Record<string, string> = {}, fetcher?: typeof fetch, withModel = false) {
  const dir = await tempDir();
  const project = join(dir, "p");
  const env = { host, cwd: dir, env: { CHATTREE_ENVIRONMENT: "off", CHATTREE_SETTINGS: join(dir, "s.yml"), ...extraEnv }, now: Date.now };
  if (withModel)
    await runInit(env, {
      dir: project,
      provider: "compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "qwen3:4b",
      maxOutput: 256,
      yes: true,
    });
  else await runInit(env, { dir: project, provider: "none" });
  const events: UiEvent[] = [];
  const c = new Controller({
    pollMs: 0,
    env,
    folders: [project],
    session: "test",
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
    send: (e) => {
      const r = parseEvent(e);
      assert.ok(r.ok, JSON.stringify(r));
      events.push(e);
    },
  });
  c.handle({ type: "ready", view: "config" });
  c.handle({ type: "ready", view: "chat" });
  await c.idle();
  const form = () => {
    const f = events.findLast((e) => e.type === "form.set");
    assert.ok(f?.type === "form.set");
    return f.form;
  };
  const notice = () => {
    const n = events.findLast((e) => e.type === "notice");
    return n?.type === "notice" ? n.message : "";
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" }).trim();
  const put = (base: string, extra: Record<string, unknown> = {}) =>
    c.handle({ type: "form.edit", id: "harness", value: { ...form().value, ...provider(base, extra) } });
  return { c, put, dir, project, events, form, notice, git };
}

const provider = (base_url: string, extra: Record<string, unknown> = {}) => ({
  providers: { local: { $tag: "openai-compatible", base_url, ...extra } },
});

describe("the controller, settings", () => {
  test("the sheet opens on harness.yml as it is, with the generated schema and no problems", async () => {
    const { form } = await rig();
    const f = form();
    assert.equal(f.id, "harness");
    assert.deepEqual(f.issues, []);
    assert.equal(f.dirty, false);
    assert.ok("properties" in f.schema);
  });

  test("an edit is checked: a key pasted in place of a variable name is a problem, a good provider is not", async () => {
    const { c, put, form } = await rig();
    put("http://localhost:1/v1", { api_key_env: "sk-abc123 def" });
    await c.idle();
    assert.ok(form().issues.some((i) => i.path.startsWith("providers.local")));
    assert.equal(form().dirty, true);
    put("http://localhost:1/v1");
    await c.idle();
    assert.deepEqual(form().issues, []);
  });

  test("saving writes the file, keeps its comments, and commits it alone with the person's message", async () => {
    const { c, put, project, form, git, notice } = await rig();
    const before = await readFile(join(project, "harness.yml"), "utf8");
    put("http://localhost:1/v1");
    c.handle({ type: "form.save", id: "harness", message: "add a local server" });
    await c.idle();
    assert.equal(form().dirty, false);
    assert.match(notice(), /saved and committed/);
    const text = await readFile(join(project, "harness.yml"), "utf8");
    assert.match(text, /openai-compatible/);
    for (const line of before.split("\n").filter((l) => l.startsWith("#"))) assert.ok(text.includes(line), line);
    assert.equal(git("log", "-1", "--format=%s"), "harness.yml: add a local server");
    assert.equal(git("show", "--name-only", "--format=", "HEAD"), "harness.yml");
    assert.equal(git("status", "--porcelain", "--", "harness.yml"), "");
  });

  test("a form with problems is not saved; reverting returns to the file", async () => {
    const { c, put, project, form, git, notice } = await rig();
    const head = git("rev-parse", "HEAD");
    put("not a url");
    c.handle({ type: "form.save", id: "harness" });
    await c.idle();
    assert.match(notice(), /has problems/);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.doesNotMatch(await readFile(join(project, "harness.yml"), "utf8"), /not a url/);
    c.handle({ type: "form.revert", id: "harness" });
    await c.idle();
    assert.equal(form().dirty, false);
    assert.deepEqual(form().value["providers"] ?? {}, {});
  });

  test("a provider is tried as it is in the edit: its keys, then what the server lists", async () => {
    const asked: string[] = [];
    const fetcher: typeof fetch = (url, init) => {
      asked.push(`${String(url)} ${new Headers(init?.headers).get("authorization") ?? ""}`);
      return Promise.resolve(Response.json({ data: [{ id: "qwen3:4b" }, { id: "llama3" }] }));
    };
    const { c, put, events } = await rig({}, fetcher);
    put("http://srv/v1", { api_key_env: "SRV_KEY" });
    c.handle({ type: "provider.test", provider: "local" });
    await c.idle();
    const status = () => events.findLast((e) => e.type === "provider.status");
    const s = status();
    assert.ok(s?.type === "provider.status");
    assert.equal(s.status.state, "error");
    assert.match(s.status.detail ?? "", /SRV_KEY is not set/);
    assert.deepEqual(asked, []);
  });

  test("with the key set the server's models are listed, authenticated", async () => {
    const asked: string[] = [];
    const fetcher: typeof fetch = (url, init) => {
      asked.push(`${String(url)} ${new Headers(init?.headers).get("authorization") ?? ""}`);
      return Promise.resolve(Response.json({ data: [{ id: "qwen3:4b" }, { id: "llama3" }] }));
    };
    const { c, put, events } = await rig({ SRV_KEY: "secret-1234" }, fetcher);
    put("http://srv/v1/", { api_key_env: "SRV_KEY" });
    c.handle({ type: "provider.test", provider: "local" });
    c.handle({ type: "provider.models", provider: "local" });
    await c.idle();
    const s = events.findLast((e) => e.type === "provider.status");
    assert.ok(s?.type === "provider.status");
    assert.deepEqual([s.status.state, s.status.detail], ["ok", "2 models"]);
    const m = events.findLast((e) => e.type === "provider.models");
    assert.ok(m?.type === "provider.models");
    assert.deepEqual(
      m.list.models.map((x) => x.id),
      ["qwen3:4b", "llama3"],
    );
    assert.deepEqual(asked, ["http://srv/v1/models Bearer secret-1234", "http://srv/v1/models Bearer secret-1234"]);
    assert.ok(!JSON.stringify(events).includes("secret-1234"));
  });

  test("a server that cannot be reached is an error with the address in it", async () => {
    const { c, put, events } = await rig({}, () => Promise.reject(new Error("connect ECONNREFUSED")));
    put("http://srv/v1");
    c.handle({ type: "provider.test", provider: "local" });
    await c.idle();
    const s = events.findLast((e) => e.type === "provider.status");
    assert.ok(s?.type === "provider.status");
    assert.match(s.status.detail ?? "", /could not reach http:\/\/srv\/v1: connect ECONNREFUSED/);
  });

  test("instruction files: found in the workspace, added, turned off and on, removed; each a change on the thread", async () => {
    const { c, project, events, notice } = await rig();
    await writeFile(join(project, "AGENTS.md"), "be brief\n");
    c.handle({ type: "ready", view: "config" });
    await c.idle();
    const state = () => {
      const e = events.findLast((x) => x.type === "instructions.set");
      assert.ok(e?.type === "instructions.set");
      return e.state;
    };
    assert.deepEqual(state().files, []);
    assert.deepEqual(state().found, [{ path: "AGENTS.md", bytes: 9 }]);
    c.handle({ type: "instructions.add", path: "./AGENTS.md" });
    await c.idle();
    assert.deepEqual(state().files, [{ path: "AGENTS.md", on: true, exists: true, bytes: 9 }]);
    assert.deepEqual(state().found, []);
    c.handle({ type: "instructions.enable", path: "AGENTS.md", on: false });
    await c.idle();
    assert.deepEqual(state().files, [{ path: "AGENTS.md", on: false, exists: true, bytes: 9 }]);
    c.handle({ type: "instructions.enable", path: "AGENTS.md", on: true });
    await c.idle();
    assert.equal(state().files[0]?.on, true);
    c.handle({ type: "instructions.remove", path: "AGENTS.md" });
    await c.idle();
    assert.deepEqual(state().files, []);
    assert.deepEqual(state().found, [{ path: "AGENTS.md", bytes: 9 }]);
    const convo = await Conversation.open(host, project);
    const files = (await convo.readEntries()).flatMap((e) =>
      e.ok && e.value.$tag === "agent_setup" && e.value.files !== undefined ? [e.value.files] : [],
    );
    await convo.close();
    assert.deepEqual(
      files.map((f) => Object.keys(f)),
      [["AGENTS.md"], ["AGENTS.md"], ["AGENTS.md"], ["AGENTS.md"]],
    );
    c.handle({ type: "instructions.add", path: "../outside.md" });
    await c.idle();
    assert.match(notice(), /outside the repository/);
    c.handle({ type: "instructions.add", path: "missing.md" });
    await c.idle();
    assert.match(notice(), /there is no file missing\.md/);
  });

  test("the thread's model settings: the adapter's schema, checked by its rules, applied as a change on the thread", async () => {
    const { c, events, notice, project } = await rig({}, undefined, true);
    const open = () => {
      const e = events.findLast((x) => x.type === "chat.open");
      assert.ok(e?.type === "chat.open");
      return e.state;
    };
    const form = () => {
      const f = events.findLast((x) => x.type === "form.set" && x.form.id === "model-settings");
      assert.ok(f?.type === "form.set");
      return f.form;
    };
    assert.equal(open().settings?.id, "model-settings");
    assert.equal(open().settings?.value["max_output_tokens"], 256);
    c.handle({ type: "form.edit", id: "model-settings", value: { max_output_tokens: 256, temperature: 9 } });
    await c.idle();
    assert.ok(form().issues.some((i) => i.path === "temperature"));
    assert.equal(form().dirty, true);
    c.handle({ type: "form.save", id: "model-settings" });
    await c.idle();
    assert.match(notice(), /have problems/);
    c.handle({ type: "form.edit", id: "model-settings", value: { max_output_tokens: 512, temperature: 0.5 } });
    c.handle({ type: "form.save", id: "model-settings" });
    await c.idle();
    assert.deepEqual(open().settings?.value, { max_output_tokens: 512, temperature: 0.5 });
    assert.equal(open().settings?.dirty, false);
    const convo = await Conversation.open(host, project);
    assert.deepEqual((await convo.setup()).model?.settings, { max_output_tokens: 512, temperature: 0.5 });
    await convo.close();
    c.handle({ type: "form.edit", id: "model-settings", value: { max_output_tokens: 1 } });
    c.handle({ type: "form.revert", id: "model-settings" });
    await c.idle();
    assert.equal(form().dirty, false);
  });

  test("choosing a model changes it on the thread, keeping the settings of the same provider; an unknown provider is a notice", async () => {
    const { c, events, notice, project } = await rig({}, undefined, true);
    c.handle({ type: "chat.model", model: "local/llama3" });
    await c.idle();
    const open = events.findLast((x) => x.type === "chat.open");
    assert.ok(open?.type === "chat.open");
    assert.equal(open.state.model.current, "local/llama3");
    const convo = await Conversation.open(host, project);
    const m = (await convo.setup()).model;
    await convo.close();
    assert.deepEqual([m?.provider, m?.id, m?.settings?.["max_output_tokens"]], ["local", "llama3", 256]);
    c.handle({ type: "chat.model", model: "nope/x" });
    await c.idle();
    assert.match(notice(), /there is no provider for nope\/x/);
  });

  test("a folder with no conversation is initialized without a provider; the first provider saved gives the trunk its model", async () => {
    const dir = await tempDir();
    const folder = join(dir, "scratch");
    await mkdir(folder, { recursive: true });
    const env = {
      host,
      cwd: dir,
      env: { CHATTREE_ENVIRONMENT: "off", CHATTREE_SETTINGS: join(dir, "s.yml"), ANTHROPIC_API_KEY: "k" },
      now: Date.now,
    };
    const events: UiEvent[] = [];
    const c = new Controller({
      pollMs: 0,
      env,
      folders: [folder],
      session: "test",
      send: (e) => {
        assert.ok(parseEvent(e).ok, JSON.stringify(e));
        events.push(e);
      },
    });
    c.handle({ type: "ready", view: "graph" });
    c.handle({ type: "ready", view: "chat" });
    await c.idle();
    const repos = events.findLast((e) => e.type === "graph.repos");
    assert.ok(repos?.type === "graph.repos");
    assert.equal(repos.repos.repos[0]?.init, "new");
    assert.equal(
      events.some((e) => e.type === "chat.open"),
      false,
    );
    events.length = 0;
    c.handle({ type: "repo.init", id: folder });
    await c.idle();
    const open = events.findLast((e) => e.type === "chat.open");
    assert.ok(open?.type === "chat.open");
    assert.deepEqual(open.state.banner, { kind: "no_provider" });
    assert.ok(events.some((e) => e.type === "settings.open" && e.page === "providers"));
    const form = events.findLast((e) => e.type === "form.set");
    assert.ok(form?.type === "form.set");
    c.handle({
      type: "form.edit",
      id: "harness",
      value: { ...form.form.value, providers: { anthropic: { $tag: "anthropic", api_key_env: "ANTHROPIC_API_KEY" } } },
    });
    c.handle({ type: "provider.test", provider: "anthropic" });
    c.handle({ type: "form.save", id: "harness" });
    await c.idle();
    const status = events.findLast((e) => e.type === "provider.status");
    assert.ok(status?.type === "provider.status" && status.status.state === "ok");
    const after = events.findLast((e) => e.type === "chat.open");
    assert.ok(after?.type === "chat.open");
    assert.equal(after.state.banner, undefined);
    assert.equal(after.state.model.current, "anthropic/claude-sonnet-5-5");
    c.handle({ type: "thread.new" });
    await c.idle();
    const fresh = events.findLast((e) => e.type === "chat.open");
    assert.ok(fresh?.type === "chat.open");
    assert.equal(fresh.state.thread.name, "thread/1");
    assert.equal(fresh.state.banner, undefined);
    assert.equal(fresh.state.model.current, "anthropic/claude-sonnet-5-5");
    await c.close();
  });
});
