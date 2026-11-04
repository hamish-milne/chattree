import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { McpPool } from "../../harness/mcp/pool.ts";
import { hashDefinition } from "../../harness/definitions.ts";
import { configValue, connectionKey, connectServer, listServer, McpServers, type McpServerConfig } from "../../harness/mcp/servers.ts";
import { harnessConfig } from "../../harness/config.ts";
import { parseConfig } from "../../src/config.ts";

const host = nodeHost();
const SERVER = fileURLToPath(new URL("../support/mcp-server.ts", import.meta.url));
const deps = { host, cwd: process.cwd(), env: {} };
const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({ command: process.execPath, args: ["--no-warnings", SERVER], allow: {}, ...over }) as McpServerConfig;
const maker = (name: string, c: McpServerConfig) => ({ open: () => connectServer(name, c, "accepted", deps), list: (client: Parameters<typeof listServer>[0]) => listServer(client, name, c, "accepted", {}) });

describe("the MCP pool", () => {
  test("holders of the same key share one connection, which closes when the last lets go", async () => {
    const pool = new McpPool();
    const c = cfg();
    const a = await pool.acquire("k", maker("fake", c));
    const b = await pool.acquire("k", maker("fake", c));
    assert.equal(a.server.client, b.server.client);
    assert.equal(pool.size, 1);
    await a.release();
    await a.release(); // twice does nothing
    assert.equal(b.server.client.closedBecause, undefined, "still held");
    await b.release();
    assert.ok(b.server.client.closedBecause !== undefined, "closed with the last lease");
    assert.equal(pool.size, 0);
    // The next holder starts it again.
    const again = await pool.acquire("k", maker("fake", c));
    assert.notEqual(again.server.client, a.server.client);
    await again.release();
  });

  test("another key is another connection, and a server that fails to start is not kept", async () => {
    const pool = new McpPool();
    const one = await pool.acquire("one", maker("fake", cfg()));
    const two = await pool.acquire("two", maker("fake", cfg()));
    assert.notEqual(one.server.client, two.server.client);
    const bad = cfg({ command: process.execPath, args: ["-e", "process.exit(3)"] });
    await assert.rejects(() => pool.acquire("bad", maker("bad", bad)));
    assert.equal(pool.size, 2);
    await Promise.all([one.release(), two.release()]);
    assert.equal(pool.size, 0);
  });

  test("a refresh reads the tools again and shows every other holder as out of date", async () => {
    const pool = new McpPool();
    const c = cfg();
    const a = await pool.acquire("k", maker("fake", c));
    const b = await pool.acquire("k", maker("fake", c));
    assert.equal(a.stale() || b.stale(), false);
    const c2 = await pool.acquire("k", maker("fake", c), { fresh: true });
    assert.equal(c2.stale(), false, "the one that refreshed has the new list");
    assert.equal(a.stale() && b.stale(), true, "the others have the old one");
    await Promise.all([a.release(), b.release(), c2.release()]);
  });

  test("a connection that has died is replaced for the next holder, and closeAll closes what is left", async () => {
    const pool = new McpPool();
    const a = await pool.acquire("k", maker("fake", cfg()));
    await a.server.client.close();
    const b = await pool.acquire("k", maker("fake", cfg()));
    assert.notEqual(b.server.client, a.server.client);
    assert.equal(b.server.client.closedBecause, undefined);
    await pool.closeAll();
    assert.ok(b.server.client.closedBecause !== undefined);
    assert.equal(pool.size, 0);
  });

  test("McpServers over a pool shares by key and its close only lets go", async () => {
    const pool = new McpPool();
    const c = cfg();
    const setup = { mcp: { fake: { hash: await hashDefinition("mcp", configValue(c)) } } } as never;
    const x = await McpServers.connect({ fake: c }, setup, deps, { pool });
    const y = await McpServers.connect({ fake: c }, setup, deps, { pool });
    assert.equal(pool.size, 1);
    assert.deepEqual(x.tools.map((t) => t.definition.name), y.tools.map((t) => t.definition.name));
    await x.close();
    assert.equal(pool.size, 1, "y still holds it");
    await y.close();
    assert.equal(pool.size, 0);
  });
});

describe("what makes two connections the same", () => {
  const key = (c: McpServerConfig, d: Partial<typeof deps> & { projectDir?: string } = {}, name = "fake") => connectionKey(name, c, { ...deps, ...d });
  test("a program in another worktree is another connection, unless the server is project-wide", () => {
    assert.notEqual(key(cfg(), { cwd: "/a" }), key(cfg(), { cwd: "/b" }));
    const wide = cfg({ scope: "project" });
    assert.equal(key(wide, { cwd: "/a", projectDir: "/p" }), key(wide, { cwd: "/b", projectDir: "/p" }));
  });
  test("a url is shared whatever the worktree, but not across a different token", () => {
    const u = { url: "http://localhost:1/mcp", bearer_env: "T", allow: {}, args: [] } as unknown as McpServerConfig;
    assert.equal(key(u, { cwd: "/a" }), key(u, { cwd: "/b" }));
    assert.notEqual(key(u, { env: { T: "one" } }), key(u, { env: { T: "two" } }));
  });
  test("approvals do not make a different connection; the name does", () => {
    assert.equal(key(cfg({ allow: { all: "2999-01-01" } })), key(cfg()));
    assert.notEqual(key(cfg(), {}, "a"), key(cfg(), {}, "b"));
  });
});

describe("harness.yml", () => {
  const parse = async (text: string) => parseConfig(text, harnessConfig);
  test("scope is for a program, and subagent.mcp takes inherit, none or names", async () => {
    const ok = await parse("mcp:\n  m: {command: x, scope: project}\nsubagent:\n  mcp: [m]\n");
    assert.ok(ok.ok, ok.ok ? "" : JSON.stringify(ok.issues));
    assert.equal(ok.ok && ok.value.subagent.mcp[0], "m");
    assert.ok(!(await parse("mcp:\n  m: {url: 'http://x.test/', scope: project}\n")).ok);
    const bare = await parse("mcp: {}\n");
    assert.ok(bare.ok && bare.value.subagent.mcp === "inherit");
    assert.ok(!(await parse("subagent: {mcp: sometimes}\n")).ok);
  });
});
