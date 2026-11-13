/**
 * Spoken test clips with a known answer, made by ffmpeg's flite synthesiser (so they need a "full" ffmpeg: hosts/ffmpeg.ts finds or
 * fetches one). Digits and the commonest short sentences, in several voices, as 16 kHz mono WAVs with `name.txt` (the words said) and `name.q`
 * (the question), which `node tools/audio-probe.ts --speech DIR` reads. The same seed makes the same clips.
 *
 *   node tools/audio-speech.ts [--count 6] [--seed 1] [--out bench-runs/audio-speech]
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FfmpegError, ensureFfmpeg } from "../hosts/ffmpeg.ts";
import { rng } from "./vision-scenarios.ts";

export const VOICES = ["slt", "awb", "rms", "kal"] as const;
const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
/** The most common short sentences of spoken English: the easiest speech to recognise that still has a clear right answer. */
export const SENTENCES = [
  "Thank you.", "I don't know.", "I know.", "What do you mean?", "I'm sorry.", "I love you.", "What are you doing?", "Come on.",
  "I don't think so.", "What's going on?", "Thank you very much.", "You're welcome.", "I have no idea.", "Let's go.", "Are you sure?",
];

export interface SpeechClip {
  name: string;
  /** What is said, as plain words. */
  text: string;
  voice: (typeof VOICES)[number];
  question: string;
}

/** The clips for a seed: `count` of digits (3 to 5 of them), then every sentence in `SENTENCES`, voices taken in turn. */
export function speechClips(o: { count: number; seed: number }): SpeechClip[] {
  const r = rng(o.seed * 6007 + 11);
  const out: SpeechClip[] = [];
  for (let i = 0; i < o.count; i++) {
    const n = 3 + Math.floor(r() * 3);
    const text = Array.from({ length: n }, () => DIGITS[Math.floor(r() * 10)]).join(" ");
    out.push({ name: `digits-${i + 1}`, text, voice: VOICES[i % VOICES.length] as SpeechClip["voice"], question: "Which digits are spoken, in order? Write each digit as a word, separated by spaces, and nothing else." });
  }
  SENTENCES.forEach((text, i) => out.push({ name: `sentence-${String(i + 1).padStart(2, "0")}`, text, voice: VOICES[(i + 1) % VOICES.length] as SpeechClip["voice"], question: "What is said in this recording? Answer with just the words." }));
  return out;
}

/** ffmpeg's arguments to speak `clip` into `out`. The text is quoted for the filter graph: only letters, spaces and . , ? ! ' are allowed. */
export function fliteArgs(clip: Pick<SpeechClip, "text" | "voice">, out: string): string[] {
  if (!/^[A-Za-z .,?!']+$/.test(clip.text)) throw new Error(`clip text must be letters, spaces and . , ? ! ': ${JSON.stringify(clip.text)}`);
  return ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `flite=text='${clip.text.replace(/'/g, "'\\''")}':voice=${clip.voice}`, "-ar", "16000", "-ac", "1", out];
}

const run = (exe: string, args: string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const p = spawn(exe, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", (c) => resolve(c ?? 1));
  });

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const v = (f: string): string | undefined => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const dir = v("--out") ?? join("bench-runs", "audio-speech");
  const exe = await ensureFfmpeg({ say: (m) => console.error(m) });
  await mkdir(dir, { recursive: true });
  let failed = 0;
  for (const c of speechClips({ count: Number(v("--count") ?? 6), seed: Number(v("--seed") ?? 1) })) {
    if ((await run(exe, fliteArgs(c, join(dir, `${c.name}.wav`)))) !== 0) {
      failed++;
      console.error(`${c.name}: ffmpeg failed; skipped`);
      continue;
    }
    await writeFile(join(dir, `${c.name}.txt`), `${c.text}\n`);
    await writeFile(join(dir, `${c.name}.q`), `${c.question}\n`);
    console.error(`${c.name} (${c.voice}): ${c.text}`);
  }
  console.error(`${failed === 0 ? "done" : `${failed} failed`}: node tools/audio-probe.ts --model NAME --kinds speech --speech ${dir}`);
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    if (e instanceof FfmpegError) console.error(`${e.message}\n${e.hint}`);
    else console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
