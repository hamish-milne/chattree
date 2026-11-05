import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, test } from "node:test";
import { localModelsSchema } from "../../localmodels/config.ts";
import { pickGguf, type RepoFile } from "../../localmodels/hf.ts";
import { Lock, LockError } from "../../localmodels/lock.ts";
import { downloadList } from "../../localmodels/plan.ts";
import { fetchDownloads, modelId, resolveDownloads, type StoreEvent } from "../../localmodels/store.ts";
import { HttpFixture } from "../support/http-fixture.ts";
import { tempDir } from "../support/tmp.ts";

const f = (path: string, size = 10): RepoFile => ({ path, size, sha256: undefined });

describe("picking a quantisation", () => {
  const files = [f("README.md"), f("Model-Q4_K_M.gguf"), f("Model-Q4_K.gguf"), f("Model-Q8_0.gguf"), f("mmproj-F16.gguf"), f("Model-UD-Q4_K_XL.gguf")];

  test("matches whole words, so Q4_K is not Q4_K_M", () => {
    assert.deepEqual(pickGguf(files, "Q4_K_M").map((x) => x.path), ["Model-Q4_K_M.gguf"]);
    assert.deepEqual(pickGguf(files, "Q4_K").map((x) => x.path), ["Model-Q4_K.gguf"]);
    assert.deepEqual(pickGguf(files, "q8_0").map((x) => x.path), ["Model-Q8_0.gguf"]);
  });

  test("says what there is when nothing matches or several do", () => {
    assert.throws(() => pickGguf(files, "Q2_K", "o/r"), /o\/r has no Q2_K file \(it has: Model-Q4_K.gguf, Model-Q4_K_M.gguf/);
    assert.throws(() => pickGguf(files, undefined, "o/r"), /more than one file/);
    assert.throws(() => pickGguf([f("README.md")], undefined, "o/r"), /no \.gguf files/);
    assert.deepEqual(pickGguf([f("only.gguf"), f("mmproj-x.gguf")], undefined).map((x) => x.path), ["only.gguf"]);
  });

  test("a split model comes as its parts, in order, from a folder named for the quantisation too", () => {
    const split = [f("Q4_K_M/m-00002-of-00002.gguf"), f("Q4_K_M/m-00001-of-00002.gguf"), f("Q8_0/m-00001-of-00003.gguf")];
    assert.deepEqual(pickGguf(split, "Q4_K_M").map((x) => x.path), ["Q4_K_M/m-00001-of-00002.gguf", "Q4_K_M/m-00002-of-00002.gguf"]);
    assert.throws(() => pickGguf(split, "Q8_0"), /split into 3 parts and only 1/);
  });
});

describe("the model store", () => {
  const body = Buffer.from("model-bytes-".repeat(2000));
  const sha = createHash("sha256").update(body).digest("hex");
  const config = localModelsSchema.parse({
    models: { small: { hf: "org/repo:Q4_K_M" }, plain: { url: "https://files.test/plain.gguf" } },
  });

  async function setup() {
    const server = await HttpFixture.start();
    const data = await tempDir();
    const lock = await Lock.open(join(data, "lock.json"));
    const events: StoreEvent[] = [];
    // Everything that would go to Hugging Face or the other host goes to the fixture.
    const fetchFn: typeof fetch = (url, init) => fetch(String(url).replace(/^https:\/\/(huggingface\.co|files\.test)/, server.base), init);
    server
      .on("/api/models/org/repo/tree/main", { body: JSON.stringify([{ type: "file", path: "Model-Q4_K_M.gguf", size: body.length, lfs: { oid: sha } }, { type: "file", path: "Model-Q8_0.gguf", size: 5 }]) })
      .on("/org/repo/resolve/main/Model-Q4_K_M.gguf", { body })
      .on("/plain.gguf", { body });
    const opts = { lock, data, fetch: fetchFn, onEvent: (e: StoreEvent) => events.push(e) };
    return { server, data, lock, events, opts };
  }

  test("resolves a quantisation, fetches the file with the hash Hugging Face gave, and records it", async () => {
    const { server, data, lock, events, opts } = await setup();
    try {
      const { downloads } = downloadList(config, { join }, data);
      const resolved = await resolveDownloads(downloads, opts);
      assert.deepEqual(resolved.map((d) => [d.model, d.file]), [["plain", "plain.gguf"], ["small", "Model-Q4_K_M.gguf"]]);
      assert.equal(resolved[1]?.sha256, sha);
      const fetched = await fetchDownloads(resolved, opts);
      assert.equal(fetched.length, 2);
      assert.equal(modelId("small", fetched), `small@${sha.slice(0, 8)}`);
      assert.equal(lock.file("models/small/Model-Q4_K_M.gguf")?.sha256, sha);
      assert.ok(events.some((e) => e.type === "download" && e.model === "small"));
      assert.ok(events.some((e) => e.type === "done" && e.model === "plain"));
    } finally {
      await server.close();
    }
  });

  test("a second run asks the network nothing", async () => {
    const { server, data, opts } = await setup();
    try {
      const { downloads } = downloadList(config, { join }, data);
      await fetchDownloads(await resolveDownloads(downloads, opts), opts);
      const before = server.seen.length;
      const lock = await Lock.open(join(data, "lock.json")); // as a new process would
      const again = { ...opts, lock, onEvent: undefined };
      const fetched = await fetchDownloads(await resolveDownloads(downloads, again), again);
      assert.equal(fetched.length, 2);
      assert.equal(server.seen.length, before);
    } finally {
      await server.close();
    }
  });

  test("a file that is not what the settings pinned is refused", async () => {
    const { server, data, opts } = await setup();
    try {
      const pinned = localModelsSchema.parse({ models: { plain: { url: "https://files.test/plain.gguf", sha256: "1".repeat(64) } } });
      const { downloads } = downloadList(pinned, { join }, data);
      await assert.rejects(fetchDownloads(downloads, opts), /not the expected file/);
    } finally {
      await server.close();
    }
  });

  test("the lock file survives a restart and refuses a file it cannot read", async () => {
    const { server, data, lock } = await setup();
    try {
      lock.setFile("a", { sha256: "x", size: 1 });
      lock.setQuant("q", ["p"]);
      await lock.save();
      const again = await Lock.open(join(data, "lock.json"));
      assert.deepEqual(again.file("a"), { sha256: "x", size: 1 });
      assert.deepEqual(again.quant("q"), ["p"]);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(data, "bad.json"), "{nope");
      await assert.rejects(Lock.open(join(data, "bad.json")), LockError);
    } finally {
      await server.close();
    }
  });
});
