import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { parse } from "yaml";
import { DaemonClient, type ClientEvent } from "../../localmodels/client.ts";
import { localModelsSchema } from "../../localmodels/config.ts";
import { Daemon, sourceSignature } from "../../localmodels/daemon.ts";
import { readInfo } from "../../localmodels/daemon-files.ts";
import { nodeSpawn, RouterEngine } from "../../localmodels/engine.ts";
import { HttpFixture } from "../support/http-fixture.ts";
import { tempDir } from "../support/tmp.ts";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "support", "fake-llama-server.mjs");

async function setup(o: { serverExtra?: string; idleMinuteMs?: number; models?: string; debounceMs?: number; code?: { root: string; dirs: string[] }; logs?: string[] } = {}) {
  const server = await HttpFixture.start();
  const dir = await tempDir();
  const data = join(dir, "data");
  for (const m of ["alpha", "beta"]) server.on(`/${m}.gguf`, { body: Buffer.from(m.repeat(300)) });
  const binary = join(dir, "fake-llama-server");
  await writeFile(binary, "");
  const file = join(dir, "settings.yml");
  const yaml = (models: string): string => `local_models:\n  llama_cpp: { path: ${JSON.stringify(binary)} }\n  server: { health_timeout: 10${o.serverExtra ?? ""} }\n  models:\n${models}`;
  const alpha = `    alpha: { url: "${server.base}/alpha.gguf" }\n`;
  const beta = `    beta: { url: "${server.base}/beta.gguf" }\n`;
  const save = async (text: string): Promise<void> => {
    const tmp = `${file}.tmp`; // as an editor does: a new file renamed over the old
    await writeFile(tmp, text);
    await rename(tmp, file);
  };
  await save(yaml(o.models ?? alpha));
  const daemon = new Daemon({
    data,
    watch: { path: file, debounceMs: o.debounceMs ?? 50, pollMs: 40 },
    ...(o.code === undefined ? {} : { codeWatch: { ...o.code, pollMs: 30 } }),
    ...(o.logs === undefined ? {} : { log: (m: string) => o.logs?.push(m) }),
    idleCheckMs: 30,
    ...(o.idleMinuteMs === undefined ? {} : { idleMinuteMs: o.idleMinuteMs }),
    loadSettings: async () => {
      const doc = parse(await readFile(file, "utf8")) as { local_models: unknown };
      return { config: localModelsSchema.parse(doc.local_models), baseDir: dir };
    },
    host: {
      platform: "linux",
      arch: "x64",
      engine: new RouterEngine({ spawn: (_b, args, spawnOpts) => nodeSpawn(process.execPath, [script, ...args], spawnOpts), pollMs: 20 }),
      pollMs: 40,
    },
  });
  await daemon.open();
  const client = new DaemonClient((await readInfo(data))!);
  const events: ClientEvent[] = [];
  const ac = new AbortController();
  const until = async (pred: () => boolean, ms = 8000): Promise<void> => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) throw new Error(`timed out; ${JSON.stringify(daemon.status())}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return {
    server,
    data,
    daemon,
    client,
    events,
    save,
    yaml,
    file,
    alpha,
    beta,
    until,
    watchEvents: () => void client.events((e) => events.push(e), ac.signal),
    stopWatching: () => ac.abort(),
    close: async () => (ac.abort(), await daemon.close(), await server.close()),
  };
}

describe("the settings file", () => {
  test("a save is applied to the running host; a save that changes nothing is not; a broken one is reported", async () => {
    const t = await setup();
    try {
      t.watchEvents();
      await t.client.start({ yes: true });
      await t.until(() => t.daemon.status().state.phase === "ready");
      const reloads = (): number => t.events.filter((e) => e.type === "settings").length;

      await t.save(t.yaml(t.alpha + t.beta));
      await t.until(() => t.daemon.status().state.models.length === 2);
      await t.until(() => reloads() === 1); // the event follows the state change

      await t.save(t.yaml(t.alpha + t.beta)); // the same again
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(reloads(), 1);

      await t.save(t.yaml(`    alpha: { url: "${t.server.base}/alpha.gguf", ctx_size: -5 }\n`));
      await t.until(() => t.daemon.status().settingsError !== undefined);
      assert.match(t.daemon.status().settingsError ?? "", /ctx_size|too_small|>0|greater/i);
      assert.equal(t.daemon.status().state.models.length, 2); // the old settings still run

      await t.save(t.yaml(t.alpha + t.beta + "    # a comment\n"));
      await t.until(() => t.daemon.status().settingsError === undefined);
    } finally {
      await t.close();
    }
  });
});

describe("a watch that does not miss", () => {
  test("a change is found by looking at the file even when no event is delivered", async () => {
    const t = await setup({ debounceMs: 600_000 }); // an event would only act after ten minutes
    try {
      await t.client.start({ yes: true });
      await t.until(() => t.daemon.status().state.phase === "ready");
      await t.save(t.yaml(t.alpha + t.beta));
      await t.until(() => t.daemon.status().state.models.length === 2);
    } finally {
      await t.close();
    }
  });

  test("a file that cannot be read is an error, the old settings keep running, and a restored file clears it and is read again", async () => {
    const t = await setup();
    try {
      t.watchEvents();
      await t.client.start({ yes: true });
      await t.until(() => t.daemon.status().state.phase === "ready");
      await rm(t.file);
      await t.until(() => t.daemon.status().settingsError !== undefined);
      assert.match(t.daemon.status().settingsError ?? "", /cannot be read/);
      assert.ok(t.events.some((e) => e.type === "settings" && e.error !== undefined));
      assert.equal(t.daemon.status().state.models.length, 1);
      await t.save(t.yaml(t.alpha + t.beta));
      await t.until(() => t.daemon.status().settingsError === undefined && t.daemon.status().state.models.length === 2);
    } finally {
      await t.close();
    }
  });
});

describe("the daemon's own code", () => {
  test("a change to a source file stops the daemon once it has settled; other files do not", async () => {
    const root = await tempDir();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "other"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    const logs: string[] = [];
    const t = await setup({ code: { root, dirs: ["src"] }, logs });
    try {
      let exited = false;
      void t.daemon.done.then(() => (exited = true));
      await writeFile(join(root, "other", "b.ts"), "x\n");
      await writeFile(join(root, "src", "notes.md"), "x\n");
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(exited, false, "files outside the watched source are not the code");
      await writeFile(join(root, "src", "a.ts"), "export const a = 2; // longer\n");
      await Promise.race([t.daemon.done, new Promise((_, no) => setTimeout(() => no(new Error("did not stop")), 5000))]);
      assert.ok(logs.some((m) => /code changed/.test(m)));
      assert.equal(await stat(join(t.data, "run", "daemon.json")).catch(() => undefined), undefined, "the state file is gone, so the next session starts a new daemon");
    } finally {
      await t.close();
    }
  });

  test("the signature changes with a file's size or time and not with other things", async () => {
    const root = await tempDir();
    await mkdir(join(root, "d", "node_modules"), { recursive: true });
    await writeFile(join(root, "d", "a.ts"), "1");
    const a = await sourceSignature(root, ["d"]);
    await writeFile(join(root, "d", "node_modules", "x.js"), "1");
    await writeFile(join(root, "d", "readme.md"), "1");
    assert.equal(await sourceSignature(root, ["d"]), a);
    await writeFile(join(root, "d", "a.ts"), "12");
    assert.notEqual(await sourceSignature(root, ["d"]), a);
  });
});

describe("leaving when idle", () => {
  test("exits after idle_exit_minutes with no model in memory and nobody attached", async () => {
    const t = await setup({ serverExtra: ", idle_exit_minutes: 1", idleMinuteMs: 300 });
    try {
      await t.client.start({ yes: true });
      await t.until(() => t.daemon.status().state.phase === "ready");
      await Promise.race([t.daemon.done, new Promise((_, no) => setTimeout(() => no(new Error("did not exit")), 5000))]);
      assert.equal(await stat(join(t.data, "run", "daemon.json")).catch(() => undefined), undefined);
    } finally {
      await t.close();
    }
  });

  test("stays while a model is loaded or a session is attached, and leaves after", async () => {
    const t = await setup({ serverExtra: ", idle_exit_minutes: 1", idleMinuteMs: 300 });
    try {
      await t.client.start({ yes: true });
      await t.until(() => t.daemon.status().state.phase === "ready");
      await t.client.load("alpha");
      let exited = false;
      void t.daemon.done.then(() => (exited = true));
      await new Promise((r) => setTimeout(r, 900));
      assert.equal(exited, false, "a loaded model is use");
      await t.client.unload("alpha");
      t.watchEvents();
      await new Promise((r) => setTimeout(r, 900));
      assert.equal(exited, false, "an attached session is use");
      t.stopWatching();
      await Promise.race([t.daemon.done, new Promise((_, no) => setTimeout(() => no(new Error("did not exit")), 5000))]);
    } finally {
      await t.close();
    }
  });
});

describe("fetching and deleting through the daemon", () => {
  test("pull fetches without starting the server, and rm deletes only while the server is stopped", async () => {
    const t = await setup();
    try {
      t.watchEvents();
      await t.client.pull([]);
      await t.until(() => t.events.some((e) => e.type === "pulled"));
      const pulled = t.events.find((e) => e.type === "pulled");
      assert.deepEqual(pulled?.type === "pulled" ? [pulled.models, pulled.error] : [], [["alpha"], undefined]);
      assert.equal(t.daemon.status().state.phase, "idle");
      assert.match(t.daemon.status().state.ids["alpha"] ?? "", /^alpha@/);

      await t.client.start({ yes: true });
      await t.until(() => t.daemon.status().state.phase === "ready");
      await assert.rejects(t.client.remove("alpha"), /stop the model host first/);
      await t.client.pull(["alpha"], { force: true });
      await t.until(() => t.events.filter((e) => e.type === "pulled").length === 2);
      const second = t.events.filter((e) => e.type === "pulled")[1];
      assert.match(second?.type === "pulled" ? (second.error ?? "") : "", /stop the model host first/);
    } finally {
      await t.close();
    }
  });
});
