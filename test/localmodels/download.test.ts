import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { downloadFile, DownloadError } from "../../localmodels/download.ts";
import { FetchError } from "../../localmodels/net.ts";
import { HttpFixture } from "../support/http-fixture.ts";
import { tempDir } from "../support/tmp.ts";

const content = Buffer.from("0123456789".repeat(5000)); // 50 kB
const sha = createHash("sha256").update(content).digest("hex");

async function setup() {
  const server = await HttpFixture.start();
  const dir = await tempDir();
  return { server, dir, dest: join(dir, "m", "model.gguf") };
}

describe("downloading a file", () => {
  test("is checked and put in place, with progress, and leaves no part file", async () => {
    const { server, dest } = await setup();
    try {
      server.on("/f", { body: content });
      const progress: number[] = [];
      const r = await downloadFile({ url: `${server.base}/f`, dest, sha256: sha, onProgress: (p) => progress.push(p.received) });
      assert.deepEqual(r, { sha256: sha, size: content.length, fetched: true });
      assert.deepEqual(await readFile(dest), content);
      assert.equal(progress.at(-1), content.length);
      assert.deepEqual(await readdir(join(dest, "..")), ["model.gguf"]);
    } finally {
      await server.close();
    }
  });

  test("a wrong hash is refused and nothing is kept", async () => {
    const { server, dest } = await setup();
    try {
      server.on("/f", { body: content });
      await assert.rejects(downloadFile({ url: `${server.base}/f`, dest, sha256: "0".repeat(64) }), (e: unknown) => e instanceof DownloadError && e.kind === "hash");
      assert.equal(await stat(dest).catch(() => undefined), undefined);
      assert.deepEqual(await readdir(join(dest, "..")), []);
    } finally {
      await server.close();
    }
  });

  test("a wrong size is refused", async () => {
    const { server, dest } = await setup();
    try {
      server.on("/f", { body: content });
      await assert.rejects(downloadFile({ url: `${server.base}/f`, dest, size: 7 }), (e: unknown) => e instanceof DownloadError && e.kind === "size");
    } finally {
      await server.close();
    }
  });

  test("continues a part file from where it stopped", async () => {
    const { server, dest } = await setup();
    try {
      server.on("/f", { body: content });
      await mkdir(join(dest, ".."), { recursive: true });
      await writeFile(`${dest}.part`, content.subarray(0, 20000));
      const r = await downloadFile({ url: `${server.base}/f`, dest, sha256: sha });
      assert.equal(r.size, content.length);
      assert.equal(server.seen.at(-1)?.headers["range"], "bytes=20000-");
      assert.deepEqual(await readFile(dest), content);
    } finally {
      await server.close();
    }
  });

  test("a cut connection stops with a clear error and the next run continues", async () => {
    const { server, dest } = await setup();
    try {
      server.on("/f", { body: content, cutAfter: 12345 });
      await assert.rejects(downloadFile({ url: `${server.base}/f`, dest, sha256: sha }), (e: unknown) => e instanceof DownloadError && e.kind === "network" && /continues from there/.test(e.message));
      assert.equal(await stat(dest).catch(() => undefined), undefined);
      assert.ok(((await stat(`${dest}.part`)).size) > 0);
      server.on("/f", { body: content });
      const r = await downloadFile({ url: `${server.base}/f`, dest, sha256: sha });
      assert.equal(r.sha256, sha);
      assert.match(String(server.seen.at(-1)?.headers["range"]), /^bytes=\d+-$/);
    } finally {
      await server.close();
    }
  });

  test("a server that ignores Range gets a fresh start", async () => {
    const { server, dest } = await setup();
    try {
      server.on("/f", { body: content, ranges: false });
      await mkdir(join(dest, ".."), { recursive: true });
      await writeFile(`${dest}.part`, content.subarray(0, 100));
      const r = await downloadFile({ url: `${server.base}/f`, dest, sha256: sha });
      assert.equal(r.sha256, sha);
      assert.deepEqual(await readFile(dest), content);
    } finally {
      await server.close();
    }
  });

  test("a part that is already the whole file is just checked", async () => {
    const { server, dest } = await setup();
    try {
      server.on("/f", { body: content });
      await mkdir(join(dest, ".."), { recursive: true });
      await writeFile(`${dest}.part`, content);
      const r = await downloadFile({ url: `${server.base}/f`, dest, sha256: sha });
      assert.equal(r.size, content.length);
      assert.deepEqual(await readFile(dest), content);
    } finally {
      await server.close();
    }
  });

  test("a part from another file is thrown away and the file fetched whole", async () => {
    const { server, dest } = await setup();
    try {
      server.on("/f", { body: content });
      await mkdir(join(dest, ".."), { recursive: true });
      await writeFile(`${dest}.part`, Buffer.concat([content, content])); // longer than the file: 416, not the same length
      const r = await downloadFile({ url: `${server.base}/f`, dest, sha256: sha });
      assert.equal(r.sha256, sha);
    } finally {
      await server.close();
    }
  });

  test("a file that is there is not fetched again, unless it is not the one asked for", async () => {
    const { server, dest } = await setup();
    try {
      server.on("/f", { body: content });
      await downloadFile({ url: `${server.base}/f`, dest, sha256: sha });
      const before = server.seen.length;
      const again = await downloadFile({ url: `${server.base}/f`, dest, sha256: sha });
      assert.equal(again.fetched, false);
      assert.equal(server.seen.length, before);
      const other = Buffer.from("something else entirely");
      server.on("/g", { body: other });
      const r = await downloadFile({ url: `${server.base}/g`, dest, sha256: createHash("sha256").update(other).digest("hex") });
      assert.equal(r.fetched, true);
      assert.deepEqual(await readFile(dest), other);
    } finally {
      await server.close();
    }
  });

  test("a token goes to the first host only, not to where it redirects", async () => {
    const { server, dest } = await setup();
    const cdn = await HttpFixture.start();
    try {
      cdn.on("/blob", { body: content });
      server.on("/f", { handle: (_req, res) => res.writeHead(302, { location: `${cdn.base}/blob` }).end() });
      await downloadFile({ url: `${server.base}/f`, dest, sha256: sha, token: "secret" });
      assert.equal(server.seen[0]?.headers["authorization"], "Bearer secret");
      assert.equal(cdn.seen[0]?.headers["authorization"], undefined);
    } finally {
      await server.close();
      await cdn.close();
    }
  });

  test("errors say what to do", async () => {
    const { server, dest } = await setup();
    try {
      server.on("/gated", { status: 401 });
      await assert.rejects(downloadFile({ url: `${server.base}/gated`, dest }), (e: unknown) => e instanceof FetchError && e.status === 401 && /hf_token_env/.test(e.message));
      await assert.rejects(downloadFile({ url: `${server.base}/missing`, dest }), (e: unknown) => e instanceof FetchError && /not found/.test(e.message));
    } finally {
      await server.close();
    }
  });
});
