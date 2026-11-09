import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { main } from "../../cli/main.ts";
import { findDaemon } from "../../localmodels/client.ts";
import { pidAlive } from "../../localmodels/daemon-files.ts";
import { HttpFixture } from "../support/http-fixture.ts";
import { tempDir } from "../support/tmp.ts";
import { testIo } from "./support.ts";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "support", "fake-llama-server.mjs");

test("chat with a local model: init takes the model from the settings, and the first message starts the host", { skip: process.platform === "win32" }, async () => {
  const server = await HttpFixture.start();
  const dir = await tempDir();
  server.on("/alpha.gguf", { body: Buffer.from("alpha".repeat(1000)) });
  const binary = join(dir, "fake-llama-server");
  await writeFile(binary, `#!/usr/bin/env node\n${await readFile(script, "utf8")}`);
  await chmod(binary, 0o755);
  const settings = join(dir, "settings.yml");
  const data = join(dir, "data");
  const log = join(dir, "requests.log");
  await writeFile(
    settings,
    `data_dir: ${JSON.stringify(data)}
local_models:
  llama_cpp: { path: ${JSON.stringify(binary)} }
  server: { health_timeout: 20 }
  models:
    alpha:
      url: "${server.base}/alpha.gguf"
      aliases: [a]
      ctx_size: 4096
      sampling: { temperature: 0.6, top_k: 20 }
`,
  );
  const env = { ...process.env, CHATTREE_SETTINGS: settings, CHATTREE_ENVIRONMENT: "off", FAKE_LLAMA_LOG: log };
  const project = join(dir, "p");
  let pid: number | undefined;
  try {
    const init = testIo(dir, { env });
    assert.equal(await main(["init", project, "--provider", "local-models", "--model", "a", "--max-output", "256"], init), 0, init.stderr);
    const config = await readFile(join(project, "harness.yml"), "utf8");
    assert.match(config, /local-models:\n\s+\$tag: local-models/);
    assert.doesNotMatch(config, /base_url|api_key/);

    const first = testIo(project, { env });
    assert.equal(await main(["say", "hi"], first), 0, first.stderr);
    assert.match(first.stderr, /starting the model host/);
    assert.match(first.stderr, /ready at http:\/\/127\.0\.0\.1:\d+/);
    assert.equal(first.stdout, "hello from alpha\n");
    pid = (await findDaemon(data))?.info.pid;
    assert.ok(pid !== undefined && pidAlive(pid));

    const requests = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(requests[0]?.["model"], "alpha"); // the alias is resolved to the model's name
    assert.equal(requests[0]?.["temperature"], 0.6); // sampling pinned in the setup
    assert.equal(requests[0]?.["top_k"], 20);

    // The history says which file answered.
    assert.match(execFileSync("git", ["-C", project, "log", "--all", "-p", "--format="], { encoding: "utf8" }), /alpha@[0-9a-f]{8}/);

    const second = testIo(project, { env });
    assert.equal(await main(["say", "again"], second), 0, second.stderr);
    assert.doesNotMatch(second.stderr, /starting the model host/);
    assert.equal((await findDaemon(data))?.info.pid, pid);
  } finally {
    await main(["models", "stop"], testIo(dir, { env }));
    for (let i = 0; i < 100 && pid !== undefined && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    if (pid !== undefined && pidAlive(pid)) process.kill(pid);
    await server.close();
  }
});

test("init with local-models needs the model to be in the settings", async () => {
  const dir = await tempDir();
  const settings = join(dir, "settings.yml");
  await writeFile(settings, `local_models:\n  models:\n    alpha: { url: "https://x.test/a.gguf" }\n    beta: { url: "https://x.test/b.gguf" }\n`);
  const env = { CHATTREE_SETTINGS: settings, CHATTREE_ENVIRONMENT: "off" };
  const none = testIo(dir, { env });
  assert.equal(await main(["init", join(dir, "p1"), "--provider", "local-models"], none), 1);
  assert.match(none.stderr, /which model\? the settings have alpha, beta/);
  const wrong = testIo(dir, { env });
  assert.equal(await main(["init", join(dir, "p2"), "--provider", "local-models", "--model", "gamma"], wrong), 1);
  assert.match(wrong.stderr, /gamma is not a model in local_models \(known: alpha, beta\)/);
  const empty = testIo(dir, { env: { CHATTREE_SETTINGS: join(dir, "missing.yml"), CHATTREE_ENVIRONMENT: "off" } });
  assert.equal(await main(["init", join(dir, "p3"), "--provider", "local-models"], empty), 1);
  assert.match(empty.stderr, /no models under local_models/);
});
