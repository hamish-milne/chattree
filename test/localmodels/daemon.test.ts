import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { findDaemon, DaemonClient, type ClientEvent } from "../../localmodels/client.ts";
import { localModelsSchema, type LocalModels } from "../../localmodels/config.ts";
import { Daemon, DaemonRunning } from "../../localmodels/daemon.ts";
import { lockFile, readInfo, stateFile, writeInfo } from "../../localmodels/daemon-files.ts";
import { nodeSpawn, RouterEngine } from "../../localmodels/engine.ts";
import { HttpFixture } from "../support/http-fixture.ts";
import { fakeLlamaRelease } from "../support/llama-release.ts";
import { tempDir } from "../support/tmp.ts";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "support", "fake-llama-server.mjs");

async function setup(llama: Record<string, unknown> | "path" = "path") {
  const server = await HttpFixture.start();
  const data = await tempDir();
  const work = await tempDir();
  await fakeLlamaRelease(server, work);
  server.on("/alpha.gguf", { body: Buffer.from("alpha".repeat(500)) });
  const binary = join(data, "fake-llama-server");
  await writeFile(binary, "");
  let models: Record<string, unknown> = { alpha: { url: `${server.base}/alpha.gguf` } };
  const parse = (): LocalModels => localModelsSchema.parse({ llama_cpp: llama === "path" ? { path: binary } : llama, server: { health_timeout: 10 }, models });
  let fail: string | undefined;
  const daemon = new Daemon({
    data,
    loadSettings: async () => {
      if (fail !== undefined) throw new Error(fail);
      return { config: parse(), baseDir: data };
    },
    host: {
      platform: "linux",
      arch: "x64",
      engine: new RouterEngine({ spawn: (_b, args, o) => nodeSpawn(process.execPath, [script, ...args], o), pollMs: 20 }),
      installDeps: { apiBase: server.base, verify: async () => undefined },
      pollMs: 50,
    },
  });
  const { port } = await daemon.open();
  const info = (await readInfo(data))!;
  const client = new DaemonClient(info);
  const events: ClientEvent[] = [];
  const ac = new AbortController();
  void client.events((e) => events.push(e), ac.signal);
  const until = async (pred: () => boolean, ms = 8000): Promise<void> => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) throw new Error(`timed out; ${JSON.stringify(daemon.status())}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const close = async (): Promise<void> => {
    ac.abort();
    await daemon.close();
    await server.close();
  };
  return { server, data, daemon, port, info, client, events, until, close, setModels: (m: Record<string, unknown>) => (models = m), setFail: (m: string | undefined) => (fail = m) };
}

describe("the daemon", () => {
  test("is found through its state file, only one runs, and a stale file is ignored", async () => {
    const { data, daemon, port, info, client, close } = await setup();
    try {
      assert.equal(info.port, port);
      if (process.platform !== "win32") assert.equal((await stat(stateFile(data))).mode & 0o777, 0o600);
      assert.equal((await findDaemon(data))?.info.port, port);
      assert.equal((await client.status()).state.phase, "idle");
      const second = new Daemon({ data, loadSettings: async () => assert.fail("must not read settings"), host: { platform: "linux", arch: "x64" } });
      await assert.rejects(second.open(), DaemonRunning);
      await close();
      assert.equal(await stat(stateFile(data)).catch(() => undefined), undefined);
      assert.equal(await stat(lockFile(data)).catch(() => undefined), undefined);
      await writeInfo(data, { pid: 2 ** 22 + 12345, port: 1, token: "x", startedAt: 0 }); // a process that is not there
      assert.equal(await findDaemon(data), undefined);
      assert.equal(await stat(stateFile(data)).catch(() => undefined), undefined);
    } finally {
      await close().catch(() => undefined);
    }
  });

  test("refuses a request without the token, from a browser, or with another host name", async () => {
    const { port, info, close } = await setup();
    try {
      const url = `http://127.0.0.1:${port}/status`;
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(url, { headers: { authorization: "Bearer wrong" } })).status, 401);
      assert.equal((await fetch(url, { headers: { authorization: `Bearer ${info.token}`, origin: "http://evil.test" } })).status, 403);
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/status", headers: { authorization: `Bearer ${info.token}`, host: "evil.test" } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
        req.on("error", reject).end();
      });
      assert.equal(status, 403);
      assert.equal((await fetch(url, { headers: { authorization: `Bearer ${info.token}` } })).status, 200);
    } finally {
      await close();
    }
  });

  test("starts the host on request, streams what happens, and stops everything on stop", async () => {
    const { data, daemon, client, events, until, close } = await setup();
    try {
      const started = await client.start({ yes: true });
      assert.equal(started.pid, process.pid);
      await until(() => daemon.status().state.phase === "ready");
      assert.deepEqual(daemon.status().state.models.map((m) => m.name), ["alpha"]);
      await until(() => events.some((e) => e.type === "store" && e.event.type === "done"));
      assert.equal(events[0]?.type, "status");
      await client.load("alpha");
      await until(() => daemon.status().state.models[0]?.state === "loaded");
      assert.ok((await client.logs(50)).some((l) => l.startsWith("listening on")));
      await client.stop();
      await daemon.done;
      assert.equal(await stat(stateFile(data)).catch(() => undefined), undefined);
    } finally {
      await close().catch(() => undefined);
    }
  });

  test("asks before installing llama.cpp, and installs when told to", async () => {
    const { daemon, client, events, until, close } = await setup({ tag: "b100" });
    try {
      await client.start({ yes: false });
      await until(() => daemon.status().consent !== undefined);
      const plan = daemon.status().consent!;
      assert.equal(plan.tag, "b100");
      assert.ok(events.some((e) => e.type === "consent" && e.plan !== undefined));
      await client.consent(true);
      await until(() => daemon.status().state.phase === "ready");
      assert.equal(daemon.status().consent, undefined);
    } finally {
      await close();
    }
  });

  test("an installation that is declined is an error and nothing is installed", async () => {
    const { daemon, client, until, close } = await setup({ tag: "b100" });
    try {
      await client.start({ yes: false });
      await until(() => daemon.status().consent !== undefined);
      await client.consent(false);
      await until(() => daemon.status().state.phase === "error");
      assert.match(daemon.status().state.error ?? "", /was not installed/);
    } finally {
      await close();
    }
  });

  test("a reload applies the new settings, and a broken settings file leaves the old ones running", async () => {
    const { server, daemon, client, until, setModels, setFail, close } = await setup();
    try {
      await client.start({ yes: true });
      await until(() => daemon.status().state.phase === "ready");
      server.on("/beta.gguf", { body: Buffer.from("beta".repeat(500)) });
      setModels({ alpha: { url: `${server.base}/alpha.gguf` }, beta: { url: `${server.base}/beta.gguf` } });
      const ok = await client.reload();
      assert.equal(ok.settingsError, undefined);
      await until(() => daemon.status().state.models.length === 2);
      setFail("local_models.models.beta.ctx_size: must be positive");
      const bad = await client.reload();
      assert.match(bad.settingsError ?? "", /must be positive/);
      assert.equal(bad.state.phase, "ready");
      assert.equal(bad.state.models.length, 2);
      setFail(undefined);
      assert.equal((await client.reload()).settingsError, undefined);
    } finally {
      await close();
    }
  });
});
