import assert from "node:assert/strict";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { findDaemon } from "../../localmodels/client.ts";
import { localModelsSchema } from "../../localmodels/config.ts";
import { Daemon } from "../../localmodels/daemon.ts";
import { nodeSpawn, RouterEngine } from "../../localmodels/engine.ts";
import { pidAlive } from "../../localmodels/daemon-files.ts";
import { HttpFixture } from "../support/http-fixture.ts";
import { fakeLlamaRelease } from "../support/llama-release.ts";
import { tempDir } from "../support/tmp.ts";
import { testIo } from "./support.ts";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "support", "fake-llama-server.mjs");

/** A settings file for a fake llama-server (a script that runs with node) and one model on a local server. */
async function setup(extra = "") {
  const server = await HttpFixture.start();
  const dir = await tempDir();
  server.on("/alpha.gguf", { body: Buffer.from("alpha".repeat(1000)) });
  const binary = join(dir, "fake-llama-server");
  await writeFile(binary, `#!/usr/bin/env node\n${await readFile(script, "utf8")}`);
  await chmod(binary, 0o755);
  const settings = join(dir, "settings.yml");
  await writeFile(
    settings,
    `data_dir: ${JSON.stringify(join(dir, "data"))}
local_models:
  llama_cpp: { path: ${JSON.stringify(binary)} }
  server: { health_timeout: 20 }
  models:
    alpha: { url: "${server.base}/alpha.gguf" }
${extra}`,
  );
  const env = { ...process.env, CHATTREE_SETTINGS: settings, CHATTREE_ENVIRONMENT: "off" };
  return { server, dir, data: join(dir, "data"), settings, env };
}

describe("chattree models", () => {
  test("without a local_models section there is nothing to start", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "s.yml"), "editor: vi\n");
    const io = testIo(dir, { env: { CHATTREE_SETTINGS: join(dir, "s.yml"), CHATTREE_DATA: join(dir, "d") } });
    assert.equal(await main(["models", "start"], io), 1);
    assert.match(io.stderr, /no local_models section/);
    assert.equal(await main(["models", "status"], io), 0);
    assert.match(io.stdout, /not running/);
    assert.equal(await main(["models", "nope"], io), 1);
  });

  test("status and stop say so when no host is running", async () => {
    const { server, env, dir } = await setup();
    try {
      const io = testIo(dir, { env });
      assert.equal(await main(["models", "status"], io), 0);
      assert.match(io.stdout, /model host: not running/);
      assert.equal(await main(["models", "stop"], io), 0);
      assert.match(io.stdout, /not running/);
    } finally {
      await server.close();
    }
  });

  test("starts a detached host that outlives the command, shows progress, is reused, and stops on request", { skip: process.platform === "win32" }, async () => {
    const { server, env, dir, data } = await setup();
    let pid: number | undefined;
    try {
      const first = testIo(dir, { env });
      assert.equal(await main(["models", "start", "-y"], first), 0, first.stderr);
      assert.match(first.stderr, /starting the model host/);
      assert.match(first.stderr, /alpha: alpha\.gguf done/);
      assert.match(first.stderr, /ready at http:\/\/127\.0\.0\.1:\d+\nmodels: alpha/);
      assert.doesNotMatch(first.stderr, /backend:/, "a llama_cpp.path is the person's own build: nothing to explain");

      const status = testIo(dir, { env });
      assert.equal(await main(["models", "status"], status), 0);
      assert.match(status.stdout, /model host: ready at http/);
      assert.match(status.stdout, /alpha\s+unloaded\s+alpha@[0-9a-f]{8}/);
      pid = (await findDaemon(data))?.info.pid;
      assert.ok(pid !== undefined && pid !== process.pid && pidAlive(pid));

      // a later session finds it and starts nothing
      const again = testIo(dir, { env });
      assert.equal(await main(["models", "start"], again), 0);
      assert.doesNotMatch(again.stderr, /starting the model host/);
      assert.equal((await findDaemon(data))?.info.pid, pid);

      const stop = testIo(dir, { env });
      assert.equal(await main(["models", "stop"], stop), 0);
      for (let i = 0; i < 100 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(pidAlive(pid), false);
      assert.equal(await findDaemon(data), undefined);
      assert.equal(await stat(join(data, "run", "daemon.json")).catch(() => undefined), undefined);
    } finally {
      if (pid !== undefined && pidAlive(pid)) process.kill(pid);
      await server.close();
    }
  });

  test("restart replaces the daemon itself, so code and settings are new", { skip: process.platform === "win32" }, async () => {
    const { server, env, dir, data } = await setup();
    let pids: number[] = [];
    try {
      assert.equal(await main(["models", "start", "-y"], testIo(dir, { env })), 0);
      const before = (await findDaemon(data))?.info.pid as number;
      pids.push(before);
      const io = testIo(dir, { env });
      assert.equal(await main(["models", "restart", "-y"], io), 0, io.stderr);
      assert.match(io.stderr, /stopping the model host[\s\S]*starting the model host[\s\S]*ready at http/);
      const after = (await findDaemon(data))?.info.pid as number;
      pids.push(after);
      assert.notEqual(after, before, "a new process");
      assert.equal(pidAlive(before), false, "and the old one is gone");
    } finally {
      for (const p of pids) if (pidAlive(p)) process.kill(p);
      await server.close();
    }
  });

  test("shows what will be installed and installs only when the answer is yes", async () => {
    const server = await HttpFixture.start();
    const dir = await tempDir();
    await fakeLlamaRelease(server, await tempDir());
    const data = join(dir, "data");
    const settings = join(dir, "settings.yml");
    await writeFile(settings, `data_dir: ${JSON.stringify(data)}\nlocal_models:\n  llama_cpp: { tag: b100 }\n  server: { health_timeout: 10 }\n  models: {}\n`);
    // The daemon runs in this process, so that the release comes from the fake server instead of github.com.
    const daemon = new Daemon({
      data,
      loadSettings: async () => ({ config: localModelsSchema.parse({ llama_cpp: { tag: "b100" }, server: { health_timeout: 10 } }), baseDir: dir }),
      host: {
        platform: "linux",
        arch: "x64",
        engine: new RouterEngine({ spawn: (_b, args, o) => nodeSpawn(process.execPath, [script, ...args], o), pollMs: 20 }),
        installDeps: { apiBase: server.base, verify: async () => undefined },
      },
    });
    await daemon.open();
    try {
      const env = { ...process.env, CHATTREE_SETTINGS: settings, CHATTREE_ENVIRONMENT: "off" };
      const answers = ["n", "y"];
      const asked: string[] = [];
      const ask = async (q: string): Promise<string> => (asked.push(q), answers.shift() ?? "n");

      const no = testIo(dir, { env, ask });
      assert.equal(await main(["models", "start"], no), 1);
      assert.match(no.stderr, /llama\.cpp b100 \(cpu\) is not installed/);
      assert.match(no.stderr, /llama-b100-bin-ubuntu-x64\.tar\.gz \(\d+ B\)/);
      assert.match(no.stderr, /sha256 [0-9a-f]{64}/);
      assert.match(no.stderr, /error: .*was not installed/);
      assert.equal(await stat(join(data, "llama.cpp")).catch(() => undefined), undefined);

      const yes = testIo(dir, { env, ask });
      assert.equal(await main(["models", "start"], yes), 0, yes.stderr);
      assert.match(yes.stderr, /installed .*llama-server/);
      assert.match(yes.stderr, /ready at/);
      assert.equal(asked.length, 2);
    } finally {
      await daemon.close();
      await server.close();
    }
  });

  test("without a terminal, a needed installation is refused with the way to agree", async () => {
    const server = await HttpFixture.start();
    const dir = await tempDir();
    await fakeLlamaRelease(server, await tempDir());
    const data = join(dir, "data");
    const settings = join(dir, "settings.yml");
    await writeFile(settings, `data_dir: ${JSON.stringify(data)}\nlocal_models:\n  llama_cpp: { tag: b100 }\n  models: {}\n`);
    const daemon = new Daemon({
      data,
      loadSettings: async () => ({ config: localModelsSchema.parse({ llama_cpp: { tag: "b100" } }), baseDir: dir }),
      host: { platform: "linux", arch: "x64", installDeps: { apiBase: server.base, verify: async () => undefined } },
    });
    await daemon.open();
    try {
      const io = testIo(dir, { env: { ...process.env, CHATTREE_SETTINGS: settings, CHATTREE_ENVIRONMENT: "off" } });
      assert.equal(await main(["models", "start"], io), 1);
      assert.match(io.stderr, /chattree models start -y/);
    } finally {
      await daemon.close();
      await server.close();
    }
  });
});
