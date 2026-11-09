import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { localModelsSchema } from "../../localmodels/config.ts";
import { DownloadError } from "../../localmodels/download.ts";
import { ensureLlamaServer, InstallDeclined, InstallError, type InstallEvent, type InstallPlan } from "../../localmodels/install.ts";
import { Lock, LockError } from "../../localmodels/lock.ts";
import { HttpFixture } from "../support/http-fixture.ts";
import { fakeLlamaRelease } from "../support/llama-release.ts";
import { tempDir } from "../support/tmp.ts";

async function setup(opts: { digest?: (b: Buffer) => string } = {}) {
  const server = await HttpFixture.start();
  const work = await tempDir();
  const data = await tempDir();
  await fakeLlamaRelease(server, work, opts.digest);
  const lock = await Lock.open(join(data, "lock.json"));
  const events: InstallEvent[] = [];
  const o = (config: Record<string, unknown>, extra: Partial<Parameters<typeof ensureLlamaServer>[0]> = {}) => ({
    data,
    config: localModelsSchema.parse({ llama_cpp: config }).llama_cpp,
    platform: "linux" as const,
    arch: "x64" as const,
    lock,
    onEvent: (e: InstallEvent) => events.push(e),
    deps: { apiBase: server.base, verify: async () => undefined },
    ...extra,
  });
  return { server, data, lock, events, o };
}

describe("backend auto", () => {
  test("installs the CUDA build, and says why, when an NVIDIA GPU is found", async () => {
    const { server, data, o } = await setup();
    try {
      const r = await ensureLlamaServer(o({ tag: "b100" }, { findGpu: async () => ({ backend: "cuda", note: "found GPU 0: NVIDIA GeForce RTX 4080" }) }));
      assert.equal(r.backend, "cuda");
      assert.equal(r.backendNote, "found GPU 0: NVIDIA GeForce RTX 4080");
      assert.match(r.binary, /b100-cuda/);
      assert.ok(data.length > 0);
      // the next start needs no GPU question answered again to find the same build
      const again = await ensureLlamaServer(o({ tag: "b100" }, { findGpu: async () => ({ backend: "cuda", note: "found" }) }));
      assert.equal(again.binary, r.binary);
    } finally {
      await server.close();
    }
  });

  test("with no GPU found it runs on the CPU and says so in plain words", async () => {
    const { server, o } = await setup();
    try {
      const r = await ensureLlamaServer(o({ tag: "b100" }, { findGpu: async () => ({ backend: undefined, note: "no NVIDIA GPU found, so llama.cpp runs on the CPU" }) }));
      assert.equal(r.backend, "cpu");
      assert.match(r.backendNote ?? "", /runs on the CPU/);
    } finally {
      await server.close();
    }
  });

  test("an explicit backend never looks for a GPU", async () => {
    const { server, o } = await setup();
    try {
      const r = await ensureLlamaServer(o({ tag: "b100", backend: "cpu" }, { findGpu: async () => assert.fail("looked for a GPU") }));
      assert.equal(r.backend, "cpu");
      assert.equal(r.backendNote, undefined);
    } finally {
      await server.close();
    }
  });
});

describe("installing llama.cpp", () => {
  test("a build tag is downloaded, checked, unpacked and recorded", async () => {
    const { server, data, lock, events, o } = await setup();
    try {
      const r = await ensureLlamaServer(o({ tag: "b100" }));
      assert.equal(r.tag, "b100");
      assert.equal(r.binary, join(data, "llama.cpp", "b100-cpu", "llama-b100", "llama-server"));
      assert.ok((await stat(r.binary)).isFile());
      assert.ok(lock.file("llama/llama-b100-bin-ubuntu-x64.tar.gz")?.sha256);
      assert.deepEqual(events.map((e) => e.type).filter((t, i, a) => a.indexOf(t) === i), ["release", "download", "unpack", "installed"]);
      assert.deepEqual(await readdir(join(data, "downloads")), []); // archives are removed
    } finally {
      await server.close();
    }
  });

  test("a second run needs no network", async () => {
    const { server, o } = await setup();
    try {
      await ensureLlamaServer(o({ tag: "b100" }));
      const before = server.seen.length;
      const again = await ensureLlamaServer(o({ tag: "b100" }));
      assert.equal(again.tag, "b100");
      assert.equal(server.seen.length, before);
    } finally {
      await server.close();
    }
  });

  test("a version tag follows the release's link to the build, and is remembered", async () => {
    const { server, o } = await setup();
    try {
      const r = await ensureLlamaServer(o({ tag: "v0.9.0" }));
      assert.equal(r.tag, "b100");
      const before = server.seen.length;
      await ensureLlamaServer(o({ tag: "v0.9.0" }));
      assert.equal(server.seen.length, before);
      await assert.rejects(ensureLlamaServer(o({ tag: "v0.1.0" })), /does not link to a build/);
    } finally {
      await server.close();
    }
  });

  test("the CUDA runtime is unpacked beside the program", async () => {
    const { server, o } = await setup();
    try {
      const r = await ensureLlamaServer(o({ tag: "b100", backend: "cuda" }));
      assert.equal(await readFile(join(r.binary, "..", "libcudart.so.12"), "utf8"), "cuda");
      assert.equal(await readFile(join(r.binary, "..", "libllama.so"), "utf8"), "lib");
    } finally {
      await server.close();
    }
  });

  test("the user is told what will be installed first, and can decline", async () => {
    const { server, data, o } = await setup();
    try {
      let seen: InstallPlan | undefined;
      await assert.rejects(
        ensureLlamaServer(
          o({ tag: "b100" }, {
            confirm: async (p) => {
              seen = p;
              return false;
            },
          }),
        ),
        InstallDeclined,
      );
      assert.equal(seen?.program.name, "llama-b100-bin-ubuntu-x64.tar.gz");
      assert.equal(seen?.program.sha256?.length, 64);
      assert.ok((seen?.program.size ?? 0) > 0);
      assert.ok(!server.seen.some((s) => s.path.startsWith("/dl/")));
      assert.equal(await stat(join(data, "llama.cpp")).catch(() => undefined), undefined);
    } finally {
      await server.close();
    }
  });

  test("a download that does not match GitHub's digest is not installed", async () => {
    const { server, data, o } = await setup({ digest: () => "9".repeat(64) });
    try {
      await assert.rejects(ensureLlamaServer(o({ tag: "b100" })), (e: unknown) => e instanceof DownloadError && e.kind === "hash");
      assert.equal(await stat(join(data, "llama.cpp")).catch(() => undefined), undefined);
    } finally {
      await server.close();
    }
  });

  test("a hash that differs from the first time is refused", async () => {
    const { server, lock, o } = await setup();
    try {
      lock.setFile("llama/llama-b100-bin-ubuntu-x64.tar.gz", { sha256: "8".repeat(64), size: 1 });
      await assert.rejects(ensureLlamaServer(o({ tag: "b100" })), LockError);
    } finally {
      await server.close();
    }
  });

  test("a program that does not start is removed and the reason is given", async () => {
    const { server, data, o } = await setup();
    try {
      await assert.rejects(
        ensureLlamaServer(o({ tag: "b100" }, { deps: { apiBase: server.base, verify: async () => "libcuda.so.1: cannot open shared object file" } })),
        (e: unknown) => e instanceof InstallError && /libcuda/.test(e.message) && /backend/.test(e.hint ?? ""),
      );
      assert.deepEqual(await readdir(join(data, "llama.cpp")), []);
    } finally {
      await server.close();
    }
  });

  test("no tag means no download; a path is used as it is", async () => {
    const { server, data, o } = await setup();
    try {
      await assert.rejects(ensureLlamaServer(o({})), (e: unknown) => e instanceof InstallError && /never picks the latest/.test(e.hint ?? ""));
      const own = join(data, "mine");
      await writeFile(own, "x");
      assert.equal((await ensureLlamaServer(o({ path: own }))).binary, own);
      await assert.rejects(ensureLlamaServer(o({ path: join(data, "nope") })), /is not a file/);
      assert.equal(server.seen.length, 0);
    } finally {
      await server.close();
    }
  });

  test("a build the release does not have for this machine says so", async () => {
    const { server, o } = await setup();
    try {
      await assert.rejects(ensureLlamaServer(o({ tag: "b100", backend: "vulkan" })), /no vulkan build for linux x64 \(it has: cpu, cuda\)/);
    } finally {
      await server.close();
    }
  });
});
