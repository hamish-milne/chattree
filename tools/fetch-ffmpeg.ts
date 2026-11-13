/**
 * Fetch ffmpeg for the audio benches on Windows (see hosts/ffmpeg.ts). On Linux and macOS install it with your package manager instead.
 *
 *   node tools/fetch-ffmpeg.ts                  download the pinned gyan.dev full build (about 100 MB or more), check its SHA-256 and install ffmpeg.exe in vendor/ffmpeg/
 *   node tools/fetch-ffmpeg.ts --from build.zip use a zip you already have (its SHA-256 is printed, and must match the pin unless --any is given)
 */
import { readFile } from "node:fs/promises";
import { sha256Of } from "../hosts/busybox.ts";
import { FFMPEG_DIR, FFMPEG_RELEASE, ensureFfmpeg, installFfmpegFromZip } from "../hosts/ffmpeg.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--from");
  if (i === -1) {
    console.log(`ensuring ffmpeg (pinned: ${FFMPEG_RELEASE.url})`);
    console.log(`ffmpeg is at ${await ensureFfmpeg({ say: (m) => console.log(m) })}`);
    return;
  }
  const zip = argv[i + 1];
  if (zip === undefined) throw new Error("--from needs a zip file");
  const got = sha256Of(await readFile(zip));
  console.log(`zip sha256 ${got}`);
  if (got !== FFMPEG_RELEASE.sha256 && !argv.includes("--any")) throw new Error(`that is not the pinned build (expected ${FFMPEG_RELEASE.sha256}); pass --any to install it anyway`);
  console.log(`ffmpeg.exe installed at ${await installFfmpegFromZip(zip, FFMPEG_DIR)}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
