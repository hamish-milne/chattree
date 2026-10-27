/**
 * Fetch busybox.exe for Windows, so that `run` can offer cat, ls, grep, sed and the other everyday utilities there
 * (docs/tools.md, 4.1). It is not part of the repository: busybox is GPL-2.0 software, so it is downloaded on request
 * and kept in vendor/busybox/ (ignored by git), and nothing is added to PATH.
 *
 *   node tools/fetch-busybox.ts                      download the pinned xPack windows-build-tools release and take busybox.exe from it (chattree does this by itself on first use; this is for doing it by hand)
 *   node tools/fetch-busybox.ts --from build-tools.zip   use a zip you already have
 *   node tools/fetch-busybox.ts --url <zip url>      another release
 *   node tools/fetch-busybox.ts --exe C:\path\busybox.exe    use a busybox.exe you already have
 *
 * The zip is unpacked with `tar` (Windows 10 and later have it). The result is checked by running `busybox.exe --list`.
 * Where it ends up is where `findBusybox` looks first; CHATTREE_BUSYBOX overrides.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUSYBOX_RELEASE, installBusyboxFromZip, nodeBusyboxDeps } from "../hosts/busybox.ts";
import { BUSYBOX_DIR } from "../hosts/node.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const exe = flag("--exe");
  if (exe !== undefined) {
    const applets = await nodeBusyboxDeps.applets(exe);
    if (applets === undefined || !applets.includes("cat")) throw new Error(`${exe} does not look like busybox`);
    await mkdir(BUSYBOX_DIR, { recursive: true });
    const dest = join(BUSYBOX_DIR, "busybox.exe");
    await copyFile(exe, dest);
    console.log(`busybox.exe installed at ${dest} (${applets.length} applets). Busybox is GPL-2.0 software; it is not part of this repository.`);
    return;
  }
  const work = await mkdtemp(join(tmpdir(), "chattree-busybox-"));
  try {
    let zip = flag("--from");
    if (zip === undefined) {
      const url = flag("--url") ?? BUSYBOX_RELEASE.url;
      console.log(`downloading ${url}`);
      zip = join(work, "download.zip");
      await writeFile(zip, await nodeBusyboxDeps.download(url));
    }
    console.log(`zip sha256 ${createHash("sha256").update(await readFile(zip)).digest("hex")}`);
    const dest = await installBusyboxFromZip(zip, BUSYBOX_DIR);
    console.log(`busybox.exe installed at ${dest}. Busybox is GPL-2.0 software; it is not part of this repository.`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
