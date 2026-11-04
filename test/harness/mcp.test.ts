import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { harnessConfig } from "../../harness/config.ts";
import { Conversation } from "../../harness/conversation.ts";
import { runLoop, syncMcpTools, syncTools, toolDrift, ToolsOutOfSync } from "../../harness/loop.ts";
import { connectServer, McpServers, pinServer, resultText, serverOf, serverState, toolName, type McpServerConfig } from "../../harness/mcp/servers.ts";
import { toPortableSchema } from "../../harness/schema-project.ts";
import { ToolRegistry } from "../../harness/tools.ts";
import { checkSchema } from "../../harness/tool-schema.ts";
import { parseConfig } from "../../src/config.ts";
import { tempDir } from "../support/tmp.ts";
import { startHttp, type FakeTool } from "../support/mcp-server.ts";

const host = nodeHost();
const SERVER = fileURLToPath(new URL("../support/mcp-server.ts", import.meta.url));
const deps = { host, cwd: process.cwd(), env: {} };
const stdioCfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({ command: process.execPath, args: ["--no-warnings", SERVER], allow: {}, ...over }) as McpServerConfig;

describe("narrowing a server's schema to the portable subset", () => {
  const ok = (s: unknown) => {
    const r = toPortableSchema(s);
    assert.ok(r.ok, r.ok ? "" : r.problems.join("; "));
    assert.deepEqual(checkSchema(r.schema), []);
    return r;
  };
  test("a plain schema passes through, closed", () => {
    const r = ok({ type: "object", properties: { text: { type: "string", description: "t" }, n: { type: "integer", minimum: 1 }, tags: { type: "array", items: { type: "string" } } }, required: ["text"] });
    assert.deepEqual(r.schema, { type: "object", properties: { text: { type: "string", description: "t" }, n: { type: "integer", minimum: 1 }, tags: { type: "array", items: { type: "string" } } }, required: ["text"], additionalProperties: false });
  });
  test("no schema, or an empty one, is a tool with no arguments", () => {
    assert.deepEqual(ok(undefined).schema, { type: "object", properties: {}, additionalProperties: false });
    assert.deepEqual(ok({ type: "object", additionalProperties: true }).schema, { type: "object", properties: {}, additionalProperties: false });
  });
  test("constraints the subset cannot say move into the description", () => {
    const r = ok({ type: "object", properties: { url: { type: "string", format: "uri", description: "where", pattern: "^http" } } });
    assert.deepEqual((r.schema["properties"] as Record<string, unknown>)["url"], { type: "string", description: 'where (format: "uri", pattern: "^http")' });
    assert.match(r.notes.join(), /url: format, pattern moved into the description|url: format: "uri"/);
  });
  test("nullable types, a null-or-one-thing choice, local references and const are followed", () => {
    const r = ok({ type: "object", properties: { a: { type: ["string", "null"] }, b: { anyOf: [{ type: "integer" }, { type: "null" }] }, c: { $ref: "#/$defs/mode" }, d: { const: "x" } }, $defs: { mode: { type: "string", enum: ["fast", "slow"] } } });
    assert.deepEqual(r.schema["properties"], { a: { type: "string" }, b: { type: "integer" }, c: { type: "string", enum: ["fast", "slow"] }, d: { type: "string", enum: ["x"] } });
  });
  test("what cannot be said is left out when optional, and refuses the tool when required", () => {
    const optional = ok({ type: "object", properties: { keep: { type: "string" }, free: { type: "object" }, either: { oneOf: [{ type: "string" }, { type: "number" }] } } });
    assert.deepEqual(Object.keys(optional.schema["properties"] as object), ["keep"]);
    assert.match(optional.notes.join("\n"), /free left out[\s\S]*either left out/);
    const required = toPortableSchema({ type: "object", properties: { free: { type: "object" } }, required: ["free"] });
    assert.ok(!required.ok && /free-form object/.test(required.problems.join()));
    assert.ok(!toPortableSchema({ type: "object", properties: { x: { $ref: "https://elsewhere/x.json" } }, required: ["x"] }).ok);
    assert.ok(!toPortableSchema({ type: "string" }).ok, "the root must be an object");
  });
});

describe("names", () => {
  test("a tool name is made safe, bounded and recognisable", () => {
    assert.equal(toolName("gh", "create.issue"), "mcp__gh__create_issue");
    const long = toolName("gh", "x".repeat(100));
    assert.ok(long.length <= 64 && long.startsWith("mcp__gh__xxx"));
    assert.equal(long, toolName("gh", "x".repeat(100)), "stable");
    assert.notEqual(long, toolName("gh", `${"x".repeat(99)}y`));
    assert.equal(serverOf("mcp__my-server__tool"), "my-server");
    assert.equal(serverOf("read"), undefined);
  });
});

describe("a connected server", () => {
  test("its tools become registry tools; calls reach it; errors and non-text content are told plainly", async () => {
    const c = await connectServer("fake", stdioCfg(), "accepted", deps);
    try {
      assert.deepEqual(c.status.tools.map((t) => t.name), ["mcp__fake__change", "mcp__fake__echo", "mcp__fake__fail", "mcp__fake__picture", "mcp__fake__slow"]);
      const registry = new ToolRegistry(c.tools);
      const echo = registry.check({ name: "mcp__fake__echo", args: { text: "hi" } });
      assert.ok(!("error" in echo));
      assert.match(registry.get("mcp__fake__echo")?.definition.description ?? "", /^\[MCP server fake\] Repeat the text back\./);
      assert.deepEqual(await (echo as { tool: { execute(a: object, c: object): Promise<unknown> } }).tool.execute({ text: "hi" }, { signal: new AbortController().signal }), { content: "echo: hi" });
      assert.match(JSON.stringify(registry.check({ name: "mcp__fake__echo", args: {} })), /text is required/);
      const fail = (await registry.get("mcp__fake__fail")?.execute({}, { signal: new AbortController().signal } as never)) as { content: string; is_error?: boolean };
      assert.deepEqual(fail, { content: "it broke", is_error: true });
      const pic = (await registry.get("mcp__fake__picture")?.execute({}, { signal: new AbortController().signal } as never)) as { content: string };
      assert.match(pic.content, /^here\n\[image \(image\/png, 3 bytes\) was returned and is not shown\]$/);
      assert.deepEqual(await registry.get("mcp__fake__echo")?.allowKeys?.({}, {} as never), ["all"]);
    } finally {
      await c.client.close();
    }
  });

  test("only and skip narrow the tools; a tool is kept as written, and only one whose schema cannot be used at all is reported and not offered", async () => {
    const tools: FakeTool[] = [
      { name: "a", description: "A", inputSchema: { type: "object", properties: {} } },
      { name: "b", description: "B", inputSchema: { type: "object", properties: {} } },
      { name: "free", description: "needs a free-form object", inputSchema: { type: "object", properties: { o: { type: "object" } }, required: ["o"] } },
      { name: "broken", description: "refers to another document", inputSchema: { type: "object", properties: { x: { $ref: "https://elsewhere.test/x.json" } } } },
    ];
    const env = { MCP_FAKE_TOOLS: JSON.stringify(tools) };
    const open: { client: { close(): Promise<void> } }[] = [];
    const connect = async (over: Partial<McpServerConfig>) => {
      const c = await connectServer("s", stdioCfg({ env, ...over }), "accepted", deps);
      open.push(c);
      return c;
    };
    try {
      const all = await connect({});
      assert.deepEqual(all.status.tools.map((t) => t.tool), ["a", "b", "free"]);
      assert.deepEqual(all.status.skipped.map((s) => s.tool), ["broken"]);
      // The definition has the schema as the server wrote it; what a portable-only model would lose is a note.
      assert.deepEqual(all.tools.find((t) => t.definition.name === "mcp__s__free")?.definition.input_schema, tools[2]?.inputSchema);
      assert.match(all.status.notes.find((n) => n.tool === "free")?.note ?? "", /portable subset: .*free-form object/);
      assert.deepEqual((await connect({ only: ["a", "free"] })).status.tools.map((t) => t.tool), ["a", "free"]);
      assert.deepEqual((await connect({ skip: ["a"] })).status.tools.map((t) => t.tool), ["b", "free"]);
    } finally {
      await Promise.all(open.map((c) => c.client.close()));
    }
  });

  test("names that collide once made safe get distinct registry names", async () => {
    const tools: FakeTool[] = ["a.b", "a_b"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } }));
    const c = await connectServer("s", stdioCfg({ env: { MCP_FAKE_TOOLS: JSON.stringify(tools) } }), "accepted", deps);
    assert.deepEqual(new Set(c.status.tools.map((t) => t.name)).size, 2);
    await c.client.close();
  });

  test("over HTTP, with a bearer token read from the environment and never recorded in the pin", async () => {
    const srv = await startHttp({ auth: "Bearer sekret" });
    try {
      const cfg = { url: srv.url, bearer_env: "TOK", args: [], allow: {} } as McpServerConfig;
      await assert.rejects(connectServer("h", cfg, "accepted", deps), /TOK is not set/);
      const c = await connectServer("h", cfg, "accepted", { ...deps, env: { TOK: "sekret" } });
      assert.equal(c.status.tools.length, 5);
      await c.client.close();
      const dir = join(await tempDir(), "c");
      const convo = await Conversation.create(host, dir, {});
      const pin = await pinServer(convo.store, cfg);
      assert.ok(!new TextDecoder().decode((await convo.store.get(pin.hash)) as Uint8Array).includes("sekret"));
    } finally {
      await srv.close();
    }
  });

  test("resultText: structured content stands in for no text; other kinds are named", () => {
    assert.equal(resultText({ content: [], structuredContent: { n: 1 } }), '{"n":1}');
    assert.equal(resultText({ content: [{ type: "resource", resource: { uri: "file:///a", text: "body" } }, { type: "resource_link", uri: "https://x", name: "X" }] }), "body\n[link: https://x (X)]");
  });
});

describe("acceptance gates everything", () => {
  const config = (over: object = {}) => ({ command: process.execPath, args: ["--no-warnings", SERVER], allow: {}, ...over }) as McpServerConfig;

  test("a server the thread has not accepted is not started; accepted, it is; a changed configuration is not", async () => {
    const convo = await Conversation.create(host, join(await tempDir(), "c"), {});
    const cfg = config();
    const before = await McpServers.connect({ fake: cfg }, await convo.setup(), deps);
    assert.deepEqual(before.status.map((s) => [s.state, s.connected]), [["new", false]]);
    assert.equal(before.tools.length, 0);
    await convo.setupChange({ mcp: { set: { fake: await pinServer(convo.store, cfg) } } });
    assert.equal(await serverState(await convo.setup(), "fake", cfg), "accepted");
    const after = await McpServers.connect({ fake: cfg }, await convo.setup(), deps);
    try {
      assert.equal(after.status[0]?.connected, true);
      assert.equal(after.tools.length, 5);
    } finally {
      await after.close();
    }
    const other = config({ args: ["--no-warnings", SERVER, "--changed"] });
    assert.equal(await serverState(await convo.setup(), "fake", other), "changed");
    const changed = await McpServers.connect({ fake: other }, await convo.setup(), deps);
    assert.deepEqual(changed.status.map((s) => [s.state, s.connected]), [["changed", false]]);
  });

  test("a server that cannot start is reported, and the others still connect", async () => {
    const convo = await Conversation.create(host, join(await tempDir(), "c"), {});
    const good = config();
    const bad = config({ command: "definitely-not-a-program-xyz", args: [] });
    await convo.setupChange({ mcp: { set: { good: await pinServer(convo.store, good), bad: await pinServer(convo.store, bad) } } });
    const set = await McpServers.connect({ good, bad }, await convo.setup(), deps);
    try {
      assert.deepEqual(set.status.map((s) => [s.name, s.connected]), [["bad", false], ["good", true]]);
      assert.match(set.status[0]?.error ?? "", /could not start|exited/);
    } finally {
      await set.close();
    }
  });
});

describe("pinning the tools", () => {
  async function accepted() {
    const convo = await Conversation.create(host, join(await tempDir(), "c"), {});
    await convo.setupChange({ model: { provider: "p", id: "m" } });
    const cfg = config();
    await convo.setupChange({ mcp: { set: { fake: await pinServer(convo.store, cfg) } } });
    const set = await McpServers.connect({ fake: cfg }, await convo.setup(), deps);
    return { convo, set, registry: new ToolRegistry(set.tools) };
  }
  const config = (): McpServerConfig => stdioCfg();

  test("syncTools leaves them alone and the loop refuses until they are accepted; syncMcpTools pins them", async () => {
    const { convo, set, registry } = await accepted();
    try {
      assert.equal(await syncTools(convo, registry), undefined, "nothing of the host's to pin, and the server's are not followed silently");
      const drift = await toolDrift(convo, registry);
      assert.equal(drift.missing.length, 5);
      const loop = runLoop(convo, { system: "s", registry } as never);
      await assert.rejects(loop.next(), ToolsOutOfSync);
      await assert.rejects(syncMcpTools(convo, registry, ["fake"], []), /tools_changed/, "the user must allow it");
      await syncMcpTools(convo, registry, ["fake"], ["tools_changed", "cache_break"]);
      assert.deepEqual(await toolDrift(convo, registry), { missing: [], changed: [], extra: [] });
    } finally {
      await set.close();
    }
  });

  test("a description changed by the server is drift, not something to follow; a tool that has gone is unpinned on request", async () => {
    const { convo, set, registry } = await accepted();
    await syncMcpTools(convo, registry, ["fake"], ["tools_changed", "cache_break"]);
    await set.close();
    const changedTools: FakeTool[] = [{ name: "echo", description: "Now it does something else.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];
    const cfg = config();
    const changedCfg = { ...cfg, env: { MCP_FAKE_TOOLS: JSON.stringify(changedTools) } } as McpServerConfig;
    // The environment is part of the configuration, so until the thread accepts it the server is not even started.
    const refused = await McpServers.connect({ fake: changedCfg }, await convo.setup(), deps);
    assert.equal(refused.status[0]?.state, "changed");
    await convo.setupChange({ mcp: { set: { fake: await pinServer(convo.store, changedCfg) } } });
    const again = await McpServers.connect({ fake: changedCfg }, await convo.setup(), deps);
    try {
      const reg2 = new ToolRegistry(again.tools);
      const drift = await toolDrift(convo, reg2);
      assert.deepEqual(drift.changed, ["mcp__fake__echo"]);
      assert.equal(drift.extra.length, 4, "the other four are gone");
      assert.equal(await syncTools(convo, reg2), undefined, "never followed silently");
      await syncMcpTools(convo, reg2, ["fake"], ["tools_changed", "cache_break"]);
      assert.deepEqual(await toolDrift(convo, reg2), { missing: [], changed: [], extra: [] });
    } finally {
      await again.close();
    }
  });
});

describe("harness.yml", () => {
  const parse = (mcp: string) => parseConfig(`providers: {}\nmcp:\n${mcp}`, harnessConfig);
  test("a command or a url, with what belongs to each", async () => {
    const good = await parse('  files:\n    command: npx\n    args: ["-y", "x"]\n    env_from: [TOKEN]\n  docs:\n    url: https://example.com/mcp\n    bearer_env: DOCS_TOKEN\n    only: [search]\n');
    assert.ok(good.ok && good.value.mcp["docs"]?.url === "https://example.com/mcp" && good.value.mcp["files"]?.args.length === 2);
    for (const bad of ["  a: {}\n", "  a: {command: x, url: 'https://x.test'}\n", "  a: {url: 'https://x.test', args: [y]}\n", "  a: {command: x, bearer_env: T}\n", "  A_b: {command: x}\n", "  a: {command: x, mystery: 1}\n", "  a: {command: x, env_from: ['not a name']}\n"]) {
      assert.equal((await parse(bad)).ok, false, bad);
    }
  });
  test("a server's own allow map takes expiry dates like a tool's", async () => {
    assert.ok((await parse("  a:\n    command: x\n    allow: {all: 2999-01-01}\n")).ok);
  });
});
