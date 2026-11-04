import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { httpTransport, McpClient, McpError, stdioTransport } from "../../harness/mcp/client.ts";
import { startHttp } from "../support/mcp-server.ts";

const host = nodeHost();
const SERVER = fileURLToPath(new URL("../support/mcp-server.ts", import.meta.url));
const opts = { clientName: "chattree-test", clientVersion: "0" };
const stdio = (env: Record<string, string> = {}) => stdioTransport(host, { command: process.execPath, args: ["--no-warnings", SERVER], env, cwd: process.cwd() });

describe("over stdio", () => {
  test("handshake, paged tool list, calls, errors and a result the tool says is an error", async () => {
    const c = await McpClient.connect(stdio({ MCP_FAKE_PAGE: "2" }), opts);
    try {
      assert.deepEqual(c.serverInfo, { name: "fake", version: "1.2.3" });
      assert.equal(c.instructions, "be careful");
      const tools = await c.listTools();
      assert.deepEqual(tools.map((t) => t.name), ["echo", "fail", "slow", "picture", "change"], "every page, in order");
      assert.deepEqual((await c.callTool("echo", { text: "hi" })).content, [{ type: "text", text: "echo: hi" }]);
      assert.equal((await c.callTool("fail", {})).isError, true);
      await assert.rejects(c.callTool("nope", {}), (e) => e instanceof McpError && e.code === -32602 && /unknown tool nope/.test(e.message));
    } finally {
      await c.close();
    }
  });

  test("a stopped call is cancelled at the server and rejects; a call that takes too long is cancelled too", async () => {
    const c = await McpClient.connect(stdio(), opts);
    try {
      const ac = new AbortController();
      const p = c.callTool("slow", {}, { signal: ac.signal });
      setTimeout(() => ac.abort(), 50);
      await assert.rejects(p, /was stopped/);
      await assert.rejects(c.callTool("slow", {}, { timeoutMs: 100 }), /timed out/);
      assert.equal((await c.callTool("echo", { text: "still fine" })).content.length, 1, "the connection survives both");
    } finally {
      await c.close();
    }
  });

  test("a list_changed notice marks the list stale until it is read again", async () => {
    const c = await McpClient.connect(stdio(), opts);
    try {
      await c.listTools();
      assert.equal(c.stale, false);
      await c.callTool("change", {});
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(c.stale, true);
      await c.listTools();
      assert.equal(c.stale, false);
    } finally {
      await c.close();
    }
  });

  test("a program that does not exist, or dies, is a clear error", async () => {
    await assert.rejects(McpClient.connect(stdioTransport(host, { command: "definitely-not-a-program-xyz", args: [], env: {}, cwd: process.cwd() }), opts), /could not start|exited/);
    await assert.rejects(McpClient.connect(stdioTransport(host, { command: process.execPath, args: ["-e", "process.stderr.write('boom\\n'); process.exit(3)"], env: {}, cwd: process.cwd() }), { ...opts, timeoutMs: 5000 }), /exited with code 3: boom/);
  });
});

describe("over HTTP", () => {
  for (const sse of [false, true]) {
    test(`${sse ? "event stream" : "JSON"} answers; the session id and protocol version are repeated; the headers and auth go out`, async () => {
      const srv = await startHttp({ sse, auth: "Bearer k", page: 3 });
      try {
        const c = await McpClient.connect(httpTransport({ url: srv.url, headers: { authorization: "Bearer k", "x-extra": "1" } }), opts);
        assert.equal((await c.listTools()).length, 5);
        assert.deepEqual((await c.callTool("echo", { text: "yo" })).content, [{ type: "text", text: "echo: yo" }]);
        await c.close();
        const later = srv.headers.filter((h) => h["mcp-session-id"] !== undefined);
        assert.ok(later.length >= 3 && later.every((h) => h["mcp-protocol-version"] === "2025-06-18" || h["mcp-protocol-version"] === undefined));
        assert.ok(srv.headers.every((h) => h["x-extra"] === "1"));
        assert.equal(srv.headers.at(-1) !== undefined, true);
      } finally {
        await srv.close();
      }
    });
  }

  test("a refused request says so, with the status", async () => {
    const srv = await startHttp({ auth: "Bearer right" });
    try {
      await assert.rejects(McpClient.connect(httpTransport({ url: srv.url, headers: { authorization: "Bearer wrong" } }), opts), /HTTP 401/);
      await assert.rejects(McpClient.connect(httpTransport({ url: "http://127.0.0.1:9/mcp", headers: {} }), opts), /could not reach/);
    } finally {
      await srv.close();
    }
  });
});
