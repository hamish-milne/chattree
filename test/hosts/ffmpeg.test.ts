import assert from "node:assert/strict";
import { access, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { sha256Of } from "../../hosts/busybox.ts";
import { FFMPEG_RELEASE, FfmpegError, ensureFfmpeg, findFfmpeg, type FfmpegDeps } from "../../hosts/ffmpeg.ts";
import { tempDir } from "../support/tmp.ts";

const ZIP = new TextEncoder().encode("pretend zip");
const release = { url: "https://example.invalid/ff.zip", sha256: sha256Of(ZIP) };

function deps(o: { bytes?: Uint8Array; fail?: boolean; probe?: "ok" | "no-flite" | "broken" } = {}): { deps: FfmpegDeps; downloads: string[] } {
  const downloads: string[] = [];
  return {
    downloads,
    deps: {
      async download(url) {
        downloads.push(url);
        if (o.fail) throw new Error("503 Service Unavailable");
        return o.bytes ?? ZIP;
      },
      async unpack(_zip, into) {
        await writeFile(join(into, "ffmpeg.exe"), "exe");
      },
      async probe() {
        return o.probe ?? "ok";
      },
    },
  };
}

describe("ffmpeg", () => {
  test("the release is pinned to the gyan.dev full build and a SHA-256", () => {
    assert.match(FFMPEG_RELEASE.url, /^https:\/\/github\.com\/GyanD\/codexffmpeg\/releases\/download\/.*full_build\.zip$/);
    assert.match(FFMPEG_RELEASE.sha256, /^[0-9a-f]{64}$/);
  });

  test("on Linux it is found on the PATH, never fetched, and a missing one points to the package manager", async () => {
    const bin = await tempDir();
    const exe = join(bin, "ffmpeg");
    await writeFile(exe, "#!/bin/sh\n");
    await chmod(exe, 0o755);
    assert.equal(await findFfmpeg({ env: { PATH: bin }, platform: "linux" }), exe);
    const d = deps();
    assert.equal(await ensureFfmpeg({ env: { PATH: bin }, platform: "linux", deps: d.deps }), exe);
    const empty = await tempDir();
    await assert.rejects(ensureFfmpeg({ env: { PATH: empty }, platform: "linux", deps: d.deps }), (e: unknown) => e instanceof FfmpegError && /not found/.test(e.message) && /apt install/.test(e.hint));
    assert.deepEqual(d.downloads, []);
  });

  test("an ffmpeg without flite, or that does not run, is refused", async () => {
    const bin = await tempDir();
    await writeFile(join(bin, "ffmpeg"), "x");
    for (const [probe, re] of [["no-flite", /no flite/], ["broken", /does not run/]] as const)
      await assert.rejects(ensureFfmpeg({ env: { PATH: bin }, platform: "linux", deps: deps({ probe }).deps }), (e: unknown) => e instanceof FfmpegError && re.test(e.message));
  });

  test("on Windows the pinned zip is fetched, checked, unpacked and installed, and the user is told", async () => {
    const dir = await tempDir();
    const said: string[] = [];
    const d = deps();
    const path = await ensureFfmpeg({ env: { PATH: "" }, platform: "win32", deps: d.deps, release, dir, say: (m) => said.push(m) });
    assert.equal(path, join(dir, "ffmpeg.exe"));
    await access(path);
    assert.deepEqual(d.downloads, [release.url]);
    assert.match(said.join(), /fetching ffmpeg.*GPL-3\.0.*large/);
    // A second call finds it and downloads nothing more.
    assert.equal(await ensureFfmpeg({ env: { PATH: "" }, platform: "win32", deps: d.deps, release, dir }), path);
    assert.equal(d.downloads.length, 1);
  });

  test("converting does not need flite: an ffmpeg without it is used when that is said", async () => {
    const bin = await tempDir();
    await writeFile(join(bin, "ffmpeg"), "x");
    const ok = await ensureFfmpeg({ env: { PATH: bin }, platform: "linux", deps: deps({ probe: "no-flite" }).deps, flite: false });
    assert.equal(ok, join(bin, "ffmpeg"));
    await assert.rejects(ensureFfmpeg({ env: { PATH: bin }, platform: "linux", deps: deps({ probe: "broken" }).deps, flite: false }), /does not run/);
  });

  test("a download with another hash, a failed download and a zip without flite install nothing", async () => {
    const dir = await tempDir();
    const run = (o: Parameters<typeof deps>[0]) => ensureFfmpeg({ env: { PATH: "" }, platform: "win32", deps: deps(o).deps, release, dir });
    await assert.rejects(run({ bytes: new TextEncoder().encode("tampered") }), (e: unknown) => e instanceof FfmpegError && /not the expected file/.test(e.message));
    await assert.rejects(run({ fail: true }), (e: unknown) => e instanceof FfmpegError && /could not fetch/.test(e.message));
    await assert.rejects(run({ probe: "no-flite" }), (e: unknown) => e instanceof FfmpegError && /no flite/.test(e.message));
    await assert.rejects(access(join(dir, "ffmpeg.exe")));
  });
});
