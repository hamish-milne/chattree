/**
 * Makes a folder of speech samples for tools/audio-probe.ts (`--speech DIR`) from recordings on Wikimedia Commons: the accent samples of
 * the English Wikipedia article's "Dialects, accents, and varieties", a reading of the Declaration of Independence, and the Yanny/Laurel
 * illusion. Each is cut to a short 16 kHz mono WAV by ffmpeg, which reads the clip from the URL without fetching the whole file (the
 * interviews are long FLACs). Nothing is downloaded until this is run, on your machine, with ffmpeg on the PATH:
 *
 *   node tools/audio-samples.ts [--out DIR] [--only NAME,NAME] [--list]
 *
 * Only the Declaration's opening has a known text, so it is scored; its words are checked as "course of human events", which any reading
 * from the start should contain within its first 25 seconds (look at the answer if it fails, in case the reading starts differently).
 * The others are `listen` scenarios whose answers are read by eye, and Yanny/Laurel asks which word is heard (neither answer is wrong).
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Sample {
  name: string;
  /** The file on Commons. */
  file: string;
  /** Where to start in it, and how long to take (seconds). */
  start: number;
  seconds: number;
  /** The words that must be in a scored answer. */
  said?: string;
  /** The question to ask instead of the usual. */
  question?: string;
}

export const SAMPLES: readonly Sample[] = [
  { name: "yanny-laurel", file: "YannyLaurel.ogg", start: 0, seconds: 10, question: "Do you hear the word 'Yanny' or the word 'Laurel'? Answer with one word." },
  { name: "declaration", file: "Declaration_of_Independence_Part_1.ogg", start: 0, seconds: 25, said: "course of human events" },
  { name: "south-african", file: "South_African_English.ogg", start: 0, seconds: 20 },
  { name: "spanish-reader", file: "Non-native_English_reading_by_Spanish_native_speaker_003.ogg", start: 0, seconds: 20 },
  { name: "australia", file: "AustraliaPart2.ogg", start: 0, seconds: 20 },
  { name: "midwest-emery", file: "Emery_Emery_Voice.ogg", start: 0, seconds: 20 },
  { name: "phone-gage", file: "On_the_phone-_Russell_Gage.ogg", start: 0, seconds: 20 },
  { name: "rp-de-botton", file: "Alain_de_Botton_on_Fear_of_Failure_at_Cannes_Lions_2012.flac", start: 20, seconds: 20 },
  { name: "cockney-baker", file: "Danny_Baker_BBC_Radio4_Desert_Island_Discs_31_Jul_2007_b012wcl4.flac", start: 60, seconds: 20 },
  { name: "estuary-brand", file: "Russell_brand_bbc_radio4_desert_island_discs_21_07_2013.flac", start: 60, seconds: 20 },
  { name: "liverpool-bishop", file: "John_bishop_bbc_radio4_desert_island_discs_24_06_2012.flac", start: 60, seconds: 20 },
  { name: "welsh-brydon", file: "Rob_Brydon_BBC_Radio4_Front_Row_18_Mar_2012_b01dhl11.flac", start: 60, seconds: 20 },
  { name: "scottish-salmond", file: "Alex_Salmond_BBC_Radio4_Desert_Island_Discs_16_January_2011_b00xgs41.flac", start: 60, seconds: 20 },
  { name: "irish-robinson", file: "Mary_Robinson_-_Desert_Island_Discs_-_28_July_2013.flac", start: 60, seconds: 20 },
  { name: "nyc-zito", file: "Chuck_Zito_on_Becoming_a_Hells_Angel.flac", start: 20, seconds: 20 },
  { name: "canadian-atwood", file: "Margaret_atwood_bbc_radio4_front_row_27_07_2007_b007tjpb.flac", start: 60, seconds: 20 },
];

export const USER_AGENT = "chattree-audio-probe/0.1 (https://github.com/hamish-milne/chattree)";

/** The URL Commons redirects to the file from, whatever directory it is stored in. */
export const sourceUrl = (file: string): string => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}`;

/** ffmpeg's arguments to cut `s` from its URL to a 16 kHz mono WAV. */
export function ffmpegArgs(s: Sample, out: string): string[] {
  return ["-hide_banner", "-loglevel", "error", "-y", "-user_agent", USER_AGENT, "-ss", String(s.start), "-t", String(s.seconds), "-i", sourceUrl(s.file), "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out];
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const v = (f: string): string | undefined => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  if (argv.includes("--list")) {
    for (const s of SAMPLES) console.log(`${s.name}\t${s.seconds}s from ${s.start}s\t${s.file}`);
    return;
  }
  const only = v("--only")?.split(",");
  for (const n of only ?? []) if (!SAMPLES.some((s) => s.name === n)) throw new Error(`--only: ${n} is not one of ${SAMPLES.map((s) => s.name).join(", ")}`);
  const dir = v("--out") ?? join("bench-runs", "audio-samples");
  await mkdir(dir, { recursive: true });
  let failed = 0;
  for (const s of SAMPLES.filter((x) => only === undefined || only.includes(x.name))) {
    console.error(`${s.name}: ${s.file}`);
    let code: number;
    try {
      code = await run("ffmpeg", ffmpegArgs(s, join(dir, `${s.name}.wav`)));
    } catch {
      throw new Error("ffmpeg was not found on the PATH: it is what cuts the clips");
    }
    if (code !== 0) {
      failed++;
      console.error(`  ffmpeg stopped with ${code}; skipped`);
      continue;
    }
    if (s.said !== undefined) await writeFile(join(dir, `${s.name}.txt`), `${s.said}\n`);
    if (s.question !== undefined) await writeFile(join(dir, `${s.name}.q`), `${s.question}\n`);
  }
  console.error(`${failed === 0 ? "done" : `${failed} failed`}: node tools/audio-probe.ts --model NAME --speech ${dir}`);
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
