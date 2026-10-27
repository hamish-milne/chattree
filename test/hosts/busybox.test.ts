import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { resolveBusybox } from "../../cli/toolset.ts";
import { CliError } from "../../cli/io.ts";
import { BUSYBOX_RELEASE, BusyboxError, ensureBusybox, sha256Of, type BusyboxDeps } from "../../hosts/busybox.ts";
import { nodeHost } from "../../hosts/node.ts";
import { tempDir } from "../support/tmp.ts";
import { testIo } from "../cli/support.ts";

const ZIP = new TextEncoder().encode("pretend zip");
const release = { url: "https://example.invalid/bb.zip", sha256: sha256Of(ZIP) };

/** Deps that fetch nothing: the "zip" is bytes, unpacking writes a busybox.exe, and `--list` answers with the given applets. */
function deps(o: { bytes?: Uint8Array; fail?: boolean; applets?: string[] | undefined } = {}): { deps: BusyboxDeps; downloads: string[] } {
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
        await writeFile(join(into, "busybox.exe"), "exe");
      },
      async applets() {
        return "applets" in o ? o.applets : ["cat", "ls"];
      },
    },
  };
}

describe("fetching busybox", () => {
  test("the release is pinned to a SHA-256", () => {
    assert.match(BUSYBOX_RELEASE.sha256, /^[0-9a-f]{64}$/);
  });


  test("the pinned zip is fetched, checked, unpacked and installed, and the user is told", async () => {
    const dir = await tempDir();
    const said: string[] = [];
    const d = deps();
    const path = await ensureBusybox({ deps: d.deps, release, dir, say: (m) => said.push(m) });
    assert.equal(path, join(dir, "busybox.exe"));
    await access(path);
    assert.deepEqual(d.downloads, [release.url]);
    assert.match(said.join(), /fetching busybox.*GPL-2\.0.*example\.invalid/);
  });

  test("a download with another hash is refused and nothing is installed", async () => {
    const dir = await tempDir();
    await assert.rejects(ensureBusybox({ deps: deps({ bytes: new TextEncoder().encode("tampered") }).deps, release, dir }), (e: unknown) => e instanceof BusyboxError && /not the expected file/.test(e.message) && /tools\.run\.busybox/.test(e.hint));
    await assert.rejects(access(join(dir, "busybox.exe")));
  });

  test("a failed download, an exe that is not busybox and a missing pin are BusyboxErrors with a hint", async () => {
    const dir = await tempDir();
    await assert.rejects(ensureBusybox({ deps: deps({ fail: true }).deps, release, dir }), (e: unknown) => e instanceof BusyboxError && /could not fetch.*503/.test(e.message));
    await assert.rejects(ensureBusybox({ deps: deps({ applets: undefined }).deps, release, dir }), (e: unknown) => e instanceof BusyboxError && /does not look like busybox/.test(e.message));
    const d = deps();
    await assert.rejects(ensureBusybox({ deps: d.deps, release: { url: release.url, sha256: "" }, dir }), (e: unknown) => e instanceof BusyboxError && /no pinned busybox/.test(e.message));
    assert.deepEqual(d.downloads, [], "nothing is downloaded without a pin");
  });
});

describe("tools.run.busybox", () => {
  const windows = async () => {
    const dir = await tempDir();
    return { ...testIo(dir), host: { ...nodeHost(), platform: "windows" as const } };
  };

  test("only Windows needs it", async () => {
    const io = testIo(await tempDir());
    assert.equal(await resolveBusybox(io, "auto", async () => assert.fail("not on posix")), undefined);
  });

  test("auto asks for the fetch; a failure reaches the user as an error with a hint, not the model", async () => {
    const io = await windows();
    assert.equal(await resolveBusybox(io, undefined, async () => "C:\\bb\\busybox.exe"), "C:\\bb\\busybox.exe");
    await assert.rejects(
      resolveBusybox(io, "auto", async () => {
        throw new BusyboxError("could not fetch busybox", "do something");
      }),
      (e: unknown) => e instanceof CliError && e.message === "could not fetch busybox" && e.hint === "do something",
    );
  });

  test("a path must be a file, and off never fetches", async () => {
    const io = await windows();
    await assert.rejects(resolveBusybox(io, join(io.cwd, "missing.exe"), async () => assert.fail("no fetch")), (e: unknown) => e instanceof CliError && /not a file/.test(e.message));
    const file = join(io.cwd, "bb.exe");
    await writeFile(file, "x");
    assert.equal(await resolveBusybox(io, file, async () => assert.fail("no fetch")), file);
    assert.equal(await resolveBusybox(io, "off", async () => assert.fail("no fetch")), undefined);
  });
});
