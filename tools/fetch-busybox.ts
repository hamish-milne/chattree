/**
 * Fetch busybox.exe for Windows, so that `run` can offer cat, ls, grep, sed and the other everyday utilities there
 * (docs/tools.md, 4.1). It is not part of the repository: busybox is GPL-2.0 software, so it is downloaded on request
 * and kept in vendor/busybox/ (ignored by git), and nothing is added to PATH.
 *
 *   node tools/fetch-busybox.ts                      download the xPack windows-build-tools release and take busybox.exe from it
 *   node tools/fetch-busybox.ts --from build-tools.zip   use a zip you already have
 *   node tools/fetch-busybox.ts --url <zip url>      another release
 *   node tools/fetch-busybox.ts --exe C:\path\busybox.exe    use a busybox.exe you already have
 *
 * The zip is unpacked with `tar` (Windows 10 and later have it). The result is checked by running `busybox.exe --list`.
 * Where it ends up is where `findBusybox` looks first; CHATTREE_BUSYBOX overrides.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUSYBOX_DIR } from "../hosts/node.ts";

const DEFAULT_URL = "https://github.com/xpack-dev-tools/windows-build-tools-xpack/releases/download/v4.4.1-3/xpack-windows-build-tools-4.4.1-3-win32-x64.zip";

async function find(dir: string, name: string): Promise<string | undefined> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = await find(p, name);
      if (hit !== undefined) return hit;
    } else if (e.name.toLowerCase() === name) return p;
  }
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const work = await mkdtemp(join(tmpdir(), "chattree-busybox-"));
  try {
    let exe = flag("--exe");
    if (exe === undefined) {
      let zip = flag("--from");
      if (zip === undefined) {
        const url = flag("--url") ?? DEFAULT_URL;
        console.log(`downloading ${url}`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
        zip = join(work, "download.zip");
        await writeFile(zip, new Uint8Array(await res.arrayBuffer()));
      }
      console.log(`zip sha256 ${createHash("sha256").update(await readFile(zip)).digest("hex")}`);
      const out = join(work, "x");
      await mkdir(out);
      const t = spawnSync("tar", ["-xf", zip, "-C", out], { encoding: "utf8" });
      if (t.status !== 0) throw new Error(`tar could not unpack the zip: ${t.stderr || t.error?.message}`);
      exe = await find(out, "busybox.exe");
      if (exe === undefined) throw new Error("busybox.exe is not in that zip");
    }
    const listed = spawnSync(exe, ["--list"], { encoding: "utf8" });
    const applets = (listed.stdout ?? "").split(/\r?\n/).filter(Boolean);
    if (listed.status !== 0 || !applets.includes("cat")) throw new Error(`${exe} does not look like busybox (--list gave ${applets.length} applets)`);
    await mkdir(BUSYBOX_DIR, { recursive: true });
    const dest = join(BUSYBOX_DIR, "busybox.exe");
    await copyFile(exe, dest);
    console.log(`busybox.exe installed at ${dest} (${applets.length} applets). Busybox is GPL-2.0 software; it is not part of this repository.`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
