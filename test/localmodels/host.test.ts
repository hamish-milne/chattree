import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { localModelsSchema, type LocalModels } from "../../localmodels/config.ts";
import { nodeSpawn, RouterEngine, type SpawnFn } from "../../localmodels/engine.ts";
import { LocalModelHost, type HostEvent, type HostState } from "../../localmodels/host.ts";
import { HttpFixture } from "../support/http-fixture.ts";
import { tempDir } from "../support/tmp.ts";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "support", "fake-llama-server.mjs");

/** Runs the fake server in place of llama-server; `extra` gives the extra arguments of each start (by its number, from 0). */
function fakeSpawn(extra: (n: number) => string[] = () => []): { spawn: SpawnFn; starts: () => number } {
  let n = 0;
  return { spawn: (_bin, args, o) => nodeSpawn(process.execPath, [script, ...args, ...extra(n++)], o), starts: () => n };
}

const gguf = (name: string) => Buffer.from(`GGUF fake ${name}`.repeat(50));

async function setup(models: Record<string, unknown>, extraConfig: Record<string, unknown> = {}, spawnExtra?: (n: number) => string[]) {
  const server = await HttpFixture.start();
  const data = await tempDir();
  const binary = join(data, "fake-llama-server");
  await writeFile(binary, "");
  for (const m of ["alpha", "beta", "gamma"]) server.on(`/${m}.gguf`, { body: gguf(m) });
  const config = (ms: Record<string, unknown>, more: Record<string, unknown> = extraConfig): LocalModels =>
    localModelsSchema.parse({ llama_cpp: { path: binary }, server: { health_timeout: 10 }, ...more, models: ms });
  const fake = fakeSpawn(spawnExtra);
  const fetchFn: typeof fetch = (url, init) => fetch(String(url).replace(/^https:\/\/files\.test/, server.base), init);
  const host = new LocalModelHost({
    data,
    config: config(models),
    platform: "linux",
    arch: "x64",
    engine: new RouterEngine({ spawn: fake.spawn, pollMs: 20 }),
    fetch: fetchFn,
    backoff: { initialMs: 10, maxMs: 40, maxFailures: 3, stableMs: 60_000 },
    pollMs: 50,
  });
  const events: HostEvent[] = [];
  host.on((e) => events.push(e));
  const phases = (): string[] => events.flatMap((e) => (e.type === "state" ? [e.state.phase] : [])).filter((p, i, a) => a[i - 1] !== p);
  const until = async (pred: (s: HostState) => boolean, ms = 8000): Promise<HostState> => {
    const t = Date.now();
    while (!pred(host.state)) {
      if (Date.now() - t > ms) throw new Error(`timed out; state is ${JSON.stringify(host.state)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return host.state;
  };
  return { server, data, host, config, events, phases, until, starts: fake.starts };
}

const url = (m: string) => `https://files.test/${m}.gguf`;
const names = (s: HostState) => s.models.map((m) => `${m.name}:${m.state}`).sort();

describe("the local model host", () => {
  test("installs, fetches, writes the preset, starts, and says so as it goes", async () => {
    const { server, data, host, phases } = await setup({ alpha: { url: url("alpha") }, beta: { url: url("beta"), ctx_size: 4096 } });
    try {
      const s = await host.start();
      assert.equal(s.phase, "ready");
      assert.match(s.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.deepEqual(names(s), ["alpha:unloaded", "beta:unloaded"]);
      assert.match(s.ids["alpha"] ?? "", /^alpha@[0-9a-f]{8}$/);
      assert.deepEqual(phases(), ["installing", "downloading", "starting", "ready"]);
      const ini = await readFile(join(data, "run", "preset.ini"), "utf8");
      assert.match(ini, /\[alpha\]\nmodel = .*alpha\.gguf/);
      assert.match(ini, /\[beta\]\n.*\nctx-size = 4096/s);
      assert.ok(host.logs().some((l) => l.startsWith("listening on")));
    } finally {
      await host.stop();
      await server.close();
    }
  });

  test("loads and unloads a model, and the state follows", async () => {
    const { server, host, until } = await setup({ alpha: { url: url("alpha") } });
    try {
      await host.start();
      await host.load("alpha");
      assert.deepEqual(names(await until((s) => s.models[0]?.state === "loaded")), ["alpha:loaded"]);
      await host.unload("alpha");
      await until((s) => s.models[0]?.state === "unloaded");
    } finally {
      await host.stop();
      await server.close();
    }
  });

  test("stops, can start again, and a second start while running changes nothing", async () => {
    const { server, host, starts } = await setup({ alpha: { url: url("alpha") } });
    try {
      const first = await host.start();
      await host.start();
      assert.equal(starts(), 1);
      await host.stop();
      assert.equal(host.state.phase, "stopped");
      assert.equal(host.state.baseUrl, undefined);
      await assert.rejects(fetch(`${first.baseUrl}/v1/models`));
      const again = await host.start();
      assert.equal(again.phase, "ready");
      assert.equal(starts(), 2);
    } finally {
      await host.stop();
      await server.close();
    }
  });

  test("a server that dies is started again, with the restarts counted", async () => {
    const { server, host, until } = await setup({ alpha: { url: url("alpha") } }, {}, (n) => (n === 0 ? ["--fake-crash-after", "300"] : []));
    try {
      await host.start();
      const s = await until((st) => st.restarts === 1 && st.phase === "ready");
      assert.deepEqual(names(s), ["alpha:unloaded"]);
    } finally {
      await host.stop();
      await server.close();
    }
  });

  test("a server that keeps dying makes the host give up and say why", async () => {
    const { server, host, until } = await setup({ alpha: { url: url("alpha") } }, {}, (n) => (n === 0 ? ["--fake-crash-after", "300"] : ["--fake-exit-code", "3"]));
    try {
      await host.start();
      const s = await until((st) => st.phase === "error");
      assert.match(s.error ?? "", /keeps stopping.*3 restarts.*boom/s);
    } finally {
      await host.stop();
      await server.close();
    }
  });

  test("a server that will not start is an error with what it printed", async () => {
    const { server, host } = await setup({ alpha: { url: url("alpha") } }, {}, () => ["--fake-exit-code", "2"]);
    try {
      await assert.rejects(host.start(), /stopped at start \(exit code 2\).*boom/s);
      assert.equal(host.state.phase, "error");
      assert.match(host.state.error ?? "", /boom/);
    } finally {
      await server.close();
    }
  });

  test("a model that cannot be fetched is an error, with the server not started", async () => {
    const { server, host, starts } = await setup({ alpha: { url: "https://files.test/missing.gguf" } });
    try {
      await assert.rejects(host.start(), /not found/);
      assert.equal(host.state.phase, "error");
      assert.equal(starts(), 0);
    } finally {
      await server.close();
    }
  });

  test("stopping during a slow start cancels it", async () => {
    const { server, host } = await setup({ alpha: { url: url("alpha") } }, {}, () => ["--fake-delay", "3000"]);
    try {
      const started = host.start().then(() => "up", (e: Error) => e.message);
      await new Promise((r) => setTimeout(r, 400));
      await host.stop();
      assert.match(await started, /cancelled/);
      assert.equal(host.state.phase, "stopped");
    } finally {
      await server.close();
    }
  });
});

describe("changing the settings of a running host", () => {
  test("a new model is fetched and appears without a restart; loaded models stay loaded", async () => {
    const { server, host, config, starts, until } = await setup({ alpha: { url: url("alpha") } });
    try {
      await host.start();
      await host.load("alpha");
      await until((s) => s.models[0]?.state === "loaded");
      const s = await host.apply(config({ alpha: { url: url("alpha") }, beta: { url: url("beta") } }));
      assert.equal(s.error, undefined);
      assert.equal(starts(), 1);
      assert.deepEqual(names(await until((st) => st.models.length === 2)), ["alpha:loaded", "beta:unloaded"]);
      assert.ok(s.ids["beta"]);
    } finally {
      await host.stop();
      await server.close();
    }
  });

  test("a model whose settings changed is unloaded so it comes back with them; others are left", async () => {
    const { server, host, config, until } = await setup({ alpha: { url: url("alpha") }, beta: { url: url("beta") } }, { server: { models_max: 2, health_timeout: 10 } });
    try {
      await host.start();
      await host.load("alpha");
      await host.load("beta");
      await until((s) => s.models.every((m) => m.state === "loaded"));
      await host.apply(config({ alpha: { url: url("alpha"), ctx_size: 2048 }, beta: { url: url("beta") } }, { server: { models_max: 2, health_timeout: 10 } }));
      assert.deepEqual(names(await until((s) => s.models.some((m) => m.state === "unloaded"))), ["alpha:unloaded", "beta:loaded"]);
    } finally {
      await host.stop();
      await server.close();
    }
  });

  test("a change to the shared defaults unloads every loaded model", async () => {
    const { server, host, config, until } = await setup({ alpha: { url: url("alpha") } });
    try {
      await host.start();
      await host.load("alpha");
      await until((s) => s.models[0]?.state === "loaded");
      await host.apply(config({ alpha: { url: url("alpha") } }, { defaults: { ctx_size: 1024 } }));
      await until((s) => s.models[0]?.state === "unloaded");
    } finally {
      await host.stop();
      await server.close();
    }
  });

  test("a change to the server restarts it", async () => {
    const { server, host, config, starts, until } = await setup({ alpha: { url: url("alpha") } });
    try {
      await host.start();
      await host.apply(config({ alpha: { url: url("alpha") } }, { server: { models_max: 2, health_timeout: 10 } }));
      assert.equal(starts(), 2);
      assert.equal((await until((s) => s.phase === "ready")).phase, "ready");
      assert.equal(host.config.server.models_max, 2);
    } finally {
      await host.stop();
      await server.close();
    }
  });

  test("a change that cannot be applied leaves the old settings running and says why", async () => {
    const { server, host, config } = await setup({ alpha: { url: url("alpha") } });
    try {
      await host.start();
      const s = await host.apply(config({ alpha: { url: url("alpha") }, gamma: { url: "https://files.test/nope.gguf" } }));
      assert.equal(s.phase, "ready");
      assert.match(s.error ?? "", /not found/);
      assert.deepEqual(names(s), ["alpha:unloaded"]);
    } finally {
      await host.stop();
      await server.close();
    }
  });

  test("while stopped, new settings are kept for the next start", async () => {
    const { server, host, config } = await setup({ alpha: { url: url("alpha") } });
    try {
      await host.apply(config({ beta: { url: url("beta") } }));
      const s = await host.start();
      assert.deepEqual(names(s), ["beta:unloaded"]);
    } finally {
      await host.stop();
      await server.close();
    }
  });
});
