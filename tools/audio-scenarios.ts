import { rng } from "./vision-scenarios.ts";

/**
 * Sounds with a known answer, made on the fly from a seed: how many beeps, which of two tones is higher, which is louder. Like the
 * pictures of tools/vision-scenarios.ts they need no files and no speech library, and the same seed gives the same sounds everywhere.
 * They test the model's hearing of simple sounds (and the audio path to it), not speech: for that a probe takes recordings of its own
 * (`speechScenarios`, from a folder of `name.wav` with the words in `name.txt`).
 */

export const AUDIO_KINDS = ["beeps", "pitch", "loudness", "speech", "listen"] as const;
export type AudioKind = (typeof AUDIO_KINDS)[number];

export interface AudioScenario {
  kind: AudioKind;
  id: string;
  wav: Uint8Array;
  question: string;
  expected: string;
  /** Whether an answer is right; a `listen` scenario has none (nothing is known of what is said, so the answers are only to be read). */
  check(answer: string): boolean;
}

export const RATE = 16_000;

/** 16-bit mono PCM in a WAV container. */
export function encodeWav(samples: Float32Array, rate = RATE): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string): void => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true));
  return out;
}

/** A sine tone of `hz` for `seconds` at `gain` (0..1), with a 10 ms fade at each end so that it does not click. */
export function tone(hz: number, seconds: number, gain = 0.6, rate = RATE): Float32Array {
  const n = Math.round(seconds * rate);
  const fade = Math.round(0.01 * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = gain * Math.sin((2 * Math.PI * hz * i) / rate) * Math.min(1, i / fade, (n - 1 - i) / fade);
  return out;
}

export const silence = (seconds: number, rate = RATE): Float32Array => new Float32Array(Math.round(seconds * rate));

export function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** The numbers an answer states, as digits or as words. */
const numbersIn = (a: string): number[] => [...a.toLowerCase().matchAll(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/g)].map((m) => WORD_NUMBERS[m[1] as string] ?? Number(m[1]));
const words = (a: string): string => a.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function make(kind: Exclude<AudioKind, "speech" | "listen">, seed: number, index: number): AudioScenario {
  const r = rng(seed * 7919 + index * 104729 + kind.length);
  const id = `${kind}-${index + 1}`;
  if (kind === "beeps") {
    const n = 2 + Math.floor(r() * 5);
    const parts: Float32Array[] = [silence(0.3)];
    for (let i = 0; i < n; i++) parts.push(tone(880, 0.2), silence(0.25));
    return { kind, id, wav: encodeWav(join(...parts)), question: "How many beeps do you hear? Answer with just the number.", expected: String(n), check: (a) => numbersIn(a).length > 0 && numbersIn(a).every((x) => x === n) };
  }
  const firstHigher = r() < 0.5;
  const ordinal = (a: string, want: "first" | "second"): boolean => new RegExp(`\\b${want}\\b`, "i").test(a) && !new RegExp(`\\b${want === "first" ? "second" : "first"}\\b`, "i").test(a);
  const want = firstHigher ? "first" : "second";
  if (kind === "pitch") {
    const [a, b] = firstHigher ? [880, 330] : [330, 880];
    return { kind, id, wav: encodeWav(join(silence(0.2), tone(a, 0.7), silence(0.4), tone(b, 0.7))), question: "Two tones play one after the other. Which one is higher in pitch, the first or the second? Answer with just 'first' or 'second'.", expected: want, check: (x) => ordinal(x, want) };
  }
  const [a, b] = firstHigher ? [0.8, 0.08] : [0.08, 0.8];
  return { kind, id, wav: encodeWav(join(silence(0.2), tone(440, 0.7, a), silence(0.4), tone(440, 0.7, b))), question: "Two tones play one after the other. Which one is louder, the first or the second? Answer with just 'first' or 'second'.", expected: want, check: (x) => ordinal(x, want) };
}

export function scenarios(o: { kinds?: readonly AudioKind[] | undefined; count: number; seed: number }): AudioScenario[] {
  const out: AudioScenario[] = [];
  for (const kind of o.kinds ?? (["beeps", "pitch", "loudness"] as const)) {
    if (kind === "speech" || kind === "listen") continue;
    for (let i = 0; i < o.count; i++) out.push(make(kind, o.seed, i));
  }
  return out;
}

/** A recording and the words said in it, as a scenario: the answer is right when it holds all of the words, in any case and punctuation. */
export function speechScenario(name: string, wav: Uint8Array, said: string, question?: string): AudioScenario {
  const expected = words(said);
  return { kind: "speech", id: `speech-${name}`, wav, question: question ?? "What is said in this recording? Answer with just the words.", expected: said.trim(), check: (a) => words(a).includes(expected) };
}

/** A recording with no known words (an accent sample, an illusion): the model is asked `question`, and its answer is only to be read. */
export function listenScenario(name: string, wav: Uint8Array, question = "Transcribe what is said, then describe the speaker's accent in a few words."): AudioScenario {
  return { kind: "listen", id: `listen-${name}`, wav, question, expected: "(read the answer)", check: () => true };
}
