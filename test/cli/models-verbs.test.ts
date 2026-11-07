import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { runModels } from "../../cli/models.ts";
import { loadSettings } from "../../cli/settings.ts";
import { localModelsSchema } from "../../localmodels/config.ts";
import { Daemon } from "../../localmodels/daemon.ts";
import { nodeSpawn, RouterEngine } from "../../localmodels/engine.ts";
import { HttpFixture } from "../support/http-fixture.ts";
import { tempDir } from "../support/tmp.ts";
import { testIo } from "./support.ts";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "support", "fake-llama-server.mjs");

async function setup(llama = "llama_cpp: { path: /nowhere }") {
  const server = await HttpFixture.start();
  const dir = await tempDir();
  server.on("/alpha.gguf", { body: Buffer.from("alpha".repeat(1000)) });
  server.on("/beta.gguf", { body: Buffer.from("beta".repeat(1000)) });
  const settings = join(dir, "settings.yml");
  const data = join(dir, "data");
  await writeFile(
    settings,
    `# my settings\ndata_dir: ${JSON.stringify(data)}\nlocal_models:\n  ${llama}   # the program\n  server: { health_timeout: 10 }\n  models:\n    alpha: { url: "${server.base}/alpha.gguf", ctx_size: 4096 }\n    beta: { url: "${server.base}/beta.gguf" }\n`,
  );
  const env = { ...process.env, CHATTREE_SETTINGS: settings, CHATTREE_ENVIRONMENT: "off" };
  const run = async (args: string[], over: Parameters<typeof testIo>[1] = {}) => {
    const io = testIo(dir, { env, ...over });
    const code = await main(["models", ...args], io);
    return { code, out: io.stdout, err: io.stderr };
  };
  return { server, dir, data, settings, env, run };
}

describe("models list, info, pull and rm (no host running)", () => {
  test("show what is downloaded, fetch it, and delete it", async () => {
    const { server, data, run } = await setup();
    try {
      const before = await run(["list"]);
      assert.match(before.out, /alpha\s+not downloaded/);
      assert.match(before.out, /beta\s+not downloaded/);

      const pull = await run(["pull", "alpha"]);
      assert.equal(pull.code, 0, pull.err);
      assert.match(pull.err, /alpha: alpha\.gguf done \(5\.0 kB\)/);
      assert.doesNotMatch(pull.err, /beta/);

      const after = await run(["list"]);
      assert.match(after.out, /alpha\s+downloaded, 5\.0 kB/);
      assert.match(after.out, /beta\s+not downloaded/);

      const info = await run(["info", "alpha"]);
      assert.match(info.out, /^alpha {3}alpha@[0-9a-f]{8}/);
      assert.match(info.out, /file: +.*alpha\.gguf \(5\.0 kB\)\n\s+sha256 [0-9a-f]{64}/);
      assert.match(info.out, /ctx_size: 4096/);

      const again = await run(["pull"]);
      assert.match(again.err, /alpha: alpha\.gguf is already here/);
      assert.match(again.err, /beta: beta\.gguf done/);

      const rm = await run(["rm", "alpha"]);
      assert.match(rm.out, /deleted 1 file \(5\.0 kB\) of alpha/);
      assert.equal(await stat(join(data, "models", "alpha")).catch(() => undefined), undefined);
      assert.match((await run(["list"])).out, /alpha\s+not downloaded/);
      assert.match((await run(["list"])).out, /beta\s+downloaded/);
    } finally {
      await server.close();
    }
  });

  test("a pull trusts what is recorded; --force fetches again; unknown names are errors", async () => {
    const { server, run } = await setup();
    try {
      await run(["pull", "beta"]);
      server.on("/beta.gguf", { body: Buffer.from("a newer beta".repeat(100)) });
      assert.match((await run(["pull", "beta"])).err, /already here/);
      const forced = await run(["pull", "beta", "--force"]);
      assert.match(forced.err, /beta: beta\.gguf done \(1\.2 kB\)/);
      assert.match((await run(["list"])).out, /beta\s+downloaded, 1\.2 kB/);

      const unknown = await run(["pull", "nope"]);
      assert.equal(unknown.code, 1);
      assert.match(unknown.err, /no model named nope in the settings/);
      assert.equal((await run(["rm", "nope"])).code, 1);
      assert.equal((await run(["info", "nope"])).code, 1);
    } finally {
      await server.close();
    }
  });
});

describe("models update", () => {
  const latest = (server: HttpFixture, tag: string, body = ""): void => void server.on("/repos/ggml-org/llama.cpp/releases/latest", { body: JSON.stringify({ tag_name: tag, body }) });
  const update = async (server: HttpFixture, dir: string, env: Record<string, string | undefined>, o: { yes?: boolean; ask?: (q: string) => Promise<string> } = {}) => {
    const io = testIo(dir, { env, ...(o.ask === undefined ? {} : { ask: o.ask }) });
    io.settings = await loadSettings(io);
    const code = await runModels(io, ["update"], { yes: o.yes === true, apiBase: server.base });
    return { code, out: io.stdout };
  };

  test("writes the newest tag into the settings, keeping the comments, when told to", async () => {
    const { server, dir, settings, env } = await setup("llama_cpp: { tag: b100 }");
    try {
      latest(server, "b200");
      const declined = await update(server, dir, env);
      assert.equal(declined.code, 1);
      assert.match(declined.out, /newest llama\.cpp is b200; the settings have b100/);
      assert.match(await readFile(settings, "utf8"), /tag: b100/);

      const asked: string[] = [];
      const said = await update(server, dir, env, { ask: async (q) => (asked.push(q), "y") });
      assert.equal(said.code, 0);
      assert.match(asked[0] ?? "", /set local_models\.llama_cpp\.tag to b200/);
      const text = await readFile(settings, "utf8");
      assert.match(text, /tag: b200/);
      assert.match(text, /# my settings/);
      assert.match(text, /# the program/);

      assert.match((await update(server, dir, env, { yes: true })).out, /b200 is the newest/);
    } finally {
      await server.close();
    }
  });

  test("a version release is followed to its build", async () => {
    const { server, dir, settings, env } = await setup("llama_cpp: { tag: b100 }");
    try {
      latest(server, "v0.9.0", "Builds https://github.com/ggml-org/llama.cpp/releases/tag/b12110");
      assert.equal((await update(server, dir, env, { yes: true })).code, 0);
      assert.match(await readFile(settings, "utf8"), /tag: b12110/);
    } finally {
      await server.close();
    }
  });
});

describe("models restart, reload and logs (host running)", () => {
  test("restart starts the server again, reload reports, logs show what the server printed, and a pull goes through the daemon", async () => {
    const { server, dir, data, env, run } = await setup();
    let starts = 0;
    const daemon = new Daemon({
      data,
      loadSettings: async () => ({ config: localModelsSchema.parse({ llama_cpp: { path: join(dir, "bin") }, server: { health_timeout: 10 }, models: { alpha: { url: `${server.base}/alpha.gguf` } } }), baseDir: dir }),
      host: {
        platform: "linux",
        arch: "x64",
        engine: new RouterEngine({ spawn: (_b, args, o) => (starts++, nodeSpawn(process.execPath, [script, ...args], o)), pollMs: 20 }),
      },
    });
    await writeFile(join(dir, "bin"), "");
    await daemon.open();
    try {
      assert.equal((await run(["start", "-y"])).code, 0);
      assert.equal(starts, 1);
      const restart = await run(["restart", "-y"]);
      assert.equal(restart.code, 0, restart.err);
      assert.match(restart.err, /ready at/);
      assert.equal(starts, 2);

      assert.match((await run(["logs", "-n", "50"])).out, /listening on \d+/);
      assert.match((await run(["reload"])).out, /model host: ready/);

      const pull = await run(["pull", "alpha"]);
      assert.equal(pull.code, 0, pull.err);
      assert.match(pull.err, /fetched alpha/);
    } finally {
      await daemon.close();
      await server.close();
    }
  });

  test("logs with no host running say so", async () => {
    const { server, run } = await setup();
    try {
      assert.match((await run(["logs"])).out, /no log: the model host has not run/);
      assert.match((await run(["reload"])).out, /not running/);
    } finally {
      await server.close();
    }
  });
});
