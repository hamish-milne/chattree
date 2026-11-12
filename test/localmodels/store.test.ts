import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, test } from "node:test";
import { localModelsSchema } from "../../localmodels/config.ts";
import { pickGguf, pickSidecar, type RepoFile } from "../../localmodels/hf.ts";
import { pruneFiles, removeModelFiles } from "../../localmodels/inventory.ts";
import { Lock, LockError } from "../../localmodels/lock.ts";
import { hfUrl } from "../../localmodels/config.ts";
import { downloadList, sourceHash } from "../../localmodels/plan.ts";
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

describe("the projector and draft files of a repository", () => {
  const f = (path: string): RepoFile => ({ path, size: 1, sha256: undefined });
  const unsloth = [f("gemma-4-12b-it-Q4_K_M.gguf"), f("gemma-4-12b-it-Q8_0.gguf"), f("mmproj-F16.gguf"), f("mmproj-BF16.gguf"), f("mtp-gemma-4-12b-it.gguf"), f("MTP/mtp-gemma-4-12b-it-Q8_0.gguf"), f("MTP/mtp-gemma-4-12b-it-BF16.gguf"), f("MTP/mtp-gemma-4-12b-it-F16.gguf")];

  test("neither is ever taken for the model", () => {
    assert.throws(() => pickGguf(unsloth, undefined, "o/r"), /more than one file \(gemma-4-12b-it-Q4_K_M.gguf, gemma-4-12b-it-Q8_0.gguf\)/);
    assert.deepEqual(pickGguf(unsloth, "Q4_K_M").map((x) => x.path), ["gemma-4-12b-it-Q4_K_M.gguf"]);
    assert.deepEqual(pickGguf([f("a-assistant-Q4_0.gguf"), f("a-Q4_0.gguf")], undefined).map((x) => x.path), ["a-Q4_0.gguf"]);
  });
  test("the preferred precision wins: a draft model in 8 bits, a projector in half precision", () => {
    assert.equal(pickSidecar(unsloth, "draft", undefined).path, "MTP/mtp-gemma-4-12b-it-Q8_0.gguf");
    assert.equal(pickSidecar(unsloth, "mmproj", undefined).path, "mmproj-F16.gguf");
    assert.equal(pickSidecar(unsloth, "draft", "BF16").path, "MTP/mtp-gemma-4-12b-it-BF16.gguf");
  });
  test("a lone file is taken, whatever it is called, and several of one rank are listed", () => {
    assert.equal(pickSidecar([f("m.gguf"), f("gemma-4-31b-it-qat-q4_0-assistant.gguf")], "draft", undefined).path, "gemma-4-31b-it-qat-q4_0-assistant.gguf");
    assert.throws(() => pickSidecar([f("a-assistant-Q4_0.gguf"), f("b-assistant-Q4_0.gguf")], "draft", undefined, "o/r"), /more than one draft model file \(a-assistant-Q4_0.gguf, b-assistant-Q4_0.gguf\)/);
    assert.throws(() => pickSidecar([f("m.gguf")], "draft", undefined, "o/r"), /o\/r has no draft model file/);
    assert.throws(() => pickSidecar(unsloth, "draft", "Q2_K", "o/r"), /no Q2_K draft model file/);
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
      assert.equal(lock.file(`files/${sourceHash(hfUrl("org/repo", "main", "Model-Q4_K_M.gguf"))}/Model-Q4_K_M.gguf`)?.sha256, sha);
      assert.ok(events.some((e) => e.type === "download" && e.model === "small"));
      assert.ok(events.some((e) => e.type === "done" && e.model === "plain"));
    } finally {
      await server.close();
    }
  });

  test("an auto projector and draft model are found in the model's repository and remembered separately", async () => {
    const { server, data, lock, opts } = await setup();
    try {
      const tree = (path: string) => ({ type: "file", path, size: 5 });
      server.on("/api/models/org/side/tree/main", { body: JSON.stringify([tree("M-Q4_K_M.gguf"), tree("mmproj-F16.gguf"), tree("mmproj-Q8_0.gguf"), tree("MTP/mtp-M-Q8_0.gguf"), tree("MTP/mtp-M-BF16.gguf")]) });
      const c = localModelsSchema.parse({ models: { m: { hf: "org/side:Q4_K_M", mmproj: "auto", speculative: { type: "draft-mtp", draft: "auto" } } } });
      const resolved = await resolveDownloads(downloadList(c, { join }, data).downloads, opts);
      assert.deepEqual(resolved.map((d) => [d.role, d.file]), [["model", "M-Q4_K_M.gguf"], ["mmproj", "mmproj-F16.gguf"], ["draft", "mtp-M-Q8_0.gguf"]]);
      assert.deepEqual(lock.quant("org/side@main:#mmproj"), ["mmproj-F16.gguf"]);
      assert.deepEqual(lock.quant("org/side@main:#draft"), ["MTP/mtp-M-Q8_0.gguf"]);
      assert.deepEqual(lock.quant("org/side@main:Q4_K_M"), ["M-Q4_K_M.gguf"]);
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

  test("two models with one source download it once", async () => {
    const { server, data, lock, opts } = await setup();
    try {
      const two = localModelsSchema.parse({ models: { a: { url: "https://files.test/plain.gguf" }, b: { url: "https://files.test/plain.gguf", speculative: "ngram-mod" } } });
      const fetched = await fetchDownloads(downloadList(two, { join }, data).downloads, opts);
      assert.equal(fetched[0]?.dest, fetched[1]?.dest);
      assert.equal(server.seen.filter((r) => r.method === "GET" && r.path.includes("plain.gguf")).length, 1);
      assert.equal(lock.filesUnder("files/").length, 1);
    } finally {
      await server.close();
    }
  });

  test("a file kept under models/<name>/ is moved to its place, not fetched again", async () => {
    const { server, data, lock, opts } = await setup();
    try {
      const { mkdir, writeFile, stat } = await import("node:fs/promises");
      await mkdir(join(data, "models", "plain"), { recursive: true });
      await writeFile(join(data, "models", "plain", "plain.gguf"), body);
      lock.setFile("models/plain/plain.gguf", { sha256: sha, size: body.length });
      const one = localModelsSchema.parse({ models: { plain: { url: "https://files.test/plain.gguf" } } });
      const fetched = await fetchDownloads(downloadList(one, { join }, data).downloads, opts);
      assert.equal(server.seen.length, 0);
      assert.equal((await stat(fetched[0]?.dest as string)).size, body.length);
      assert.equal(await stat(join(data, "models", "plain", "plain.gguf")).catch(() => undefined), undefined);
      assert.equal(lock.file("models/plain/plain.gguf"), undefined);
      assert.equal(lock.filesUnder("files/").length, 1);
    } finally {
      await server.close();
    }
  });
});

describe("removing and pruning shared files", () => {
  const body = Buffer.from("x".repeat(100));
  const sha = createHash("sha256").update(body).digest("hex");

  async function two() {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const data = await tempDir();
    const lock = await Lock.open(join(data, "lock.json"));
    const config = localModelsSchema.parse({ models: { a: { url: "https://files.test/m.gguf" }, b: { url: "https://files.test/m.gguf" }, c: { url: "https://files.test/c.gguf" } } });
    for (const d of downloadList(config, { join }, data).downloads) {
      await mkdir(join(d.dest as string, ".."), { recursive: true });
      await writeFile(d.dest as string, body);
      lock.setFile(`files/${sourceHash(d.url as string)}/${d.file}`, { sha256: sha, size: body.length });
    }
    return { data, lock, config };
  }

  test("a model's removal leaves a file another model uses, and takes it when it is the last", async () => {
    const { data, lock, config } = await two();
    const r = await removeModelFiles(config, lock, data, "a");
    assert.deepEqual(r, { files: 0, bytes: 0, kept: 1 });
    assert.equal(lock.filesUnder("files/").length, 2);
    const alone = await removeModelFiles(config, lock, data, "c");
    assert.deepEqual(alone, { files: 1, bytes: 100, kept: 0 });
    const forced = await removeModelFiles(config, lock, data, "b", { shared: true });
    assert.equal(forced.files, 1);
    assert.equal(lock.filesUnder("files/").length, 0);
  });

  test("prune deletes recorded files no model uses, including copies left under models/", async () => {
    const { data, lock, config } = await two();
    const { writeFile, mkdir, stat } = await import("node:fs/promises");
    await mkdir(join(data, "models", "b"), { recursive: true });
    await writeFile(join(data, "models", "b", "m.gguf"), body);
    lock.setFile("models/b/m.gguf", { sha256: sha, size: body.length });
    const { models: _all, ...rest } = config;
    const fewer = { ...rest, models: { a: config.models["a"] } } as typeof config;
    const r = await pruneFiles(fewer, lock, data);
    assert.deepEqual(r, { files: 2, bytes: 200 });
    assert.equal(lock.filesUnder("models/").length, 0);
    assert.equal(lock.filesUnder("files/").length, 1);
    assert.equal(await stat(join(data, "models", "b", "m.gguf")).catch(() => undefined), undefined);
  });

});
