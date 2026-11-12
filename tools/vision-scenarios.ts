import { Canvas, COLORS, textDots, type Rgb } from "./raster.ts";

/**
 * Pictures with a known answer, made on the fly from a seed (tools/raster.ts): which shapes and colours, how many, where, and the text,
 * digits and sums written in them. Each scenario carries the PNG, the question and a check of the answer, so a probe can ask a model
 * about as many as it likes and the same seed gives the same pictures everywhere. Shapes read the model's picture path, text its character
 * reading (OCR), and the kinds can be mixed to see which of the two a projector model is weak at.
 */

export const KINDS = ["shape", "count", "position", "text", "digits", "sum"] as const;
export type Kind = (typeof KINDS)[number];

export interface Scenario {
  kind: Kind;
  id: string;
  png: Uint8Array;
  question: string;
  expected: string;
  /** Whether an answer says the expected thing (and not also something else of the same sort). */
  check(answer: string): boolean;
}

export const SIZE = 384;

/** A small seeded generator (mulberry32): the same seed gives the same sequence. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const shuffle = <T>(r: Rand, xs: readonly T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
};

const SHAPES = ["circle", "square", "triangle"] as const;
type Shape = (typeof SHAPES)[number];
const PAINT = ["red", "green", "blue", "yellow", "purple"] as const;
type Paint = (typeof PAINT)[number];
const WORDS = ["QUOKKA", "LANTERN", "MARBLE", "CACTUS", "HARBOR", "VELVET", "ORCHID", "BISCUIT", "GLACIER", "PEPPER", "TURNIP", "ANCHOR"];

const GRID = 4;
const CELL = SIZE / GRID;
const cellCentre = (c: number): [number, number] => [(c % GRID) * CELL + CELL / 2, Math.floor(c / GRID) * CELL + CELL / 2];

function draw(cv: Canvas, shape: Shape, cx: number, cy: number, paint: Paint): void {
  const c: Rgb = COLORS[paint];
  const s = CELL * 0.7;
  if (shape === "circle") cv.fillCircle(cx, cy, s / 2, c);
  else if (shape === "square") cv.fillRect(cx - s / 2, cy - s / 2, s, s, c);
  else cv.fillTriangle(cx, cy, s, c);
}

/** One word on one line, as large as the picture takes. */
function writing(r: Rand, s: string): Canvas {
  const dark = r() < 0.5;
  const cv = new Canvas(SIZE, SIZE / 2, dark ? COLORS.white : COLORS.black);
  const scale = Math.max(2, Math.floor((SIZE - 32) / textDots(s)));
  const w = textDots(s) * scale;
  cv.text(s, Math.floor((SIZE - w) / 2), Math.floor((SIZE / 2 - 7 * scale) / 2), scale, dark ? COLORS.black : COLORS.white);
  return cv;
}

const has = (answer: string, word: string): boolean => new RegExp(`\\b${word}\\b`, "i").test(answer);
const digitsIn = (answer: string): string[] => answer.match(/\d+/g) ?? [];

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
/** The numbers an answer states, as digits or as words. */
const numbersIn = (answer: string): number[] => [...digitsIn(answer).map(Number), ...NUMBER_WORDS.flatMap((w, n) => (has(answer, w) ? [n] : []))];

export function make(kind: Kind, seed: number): Scenario {
  const r = rng(seed * 7919 + KINDS.indexOf(kind) * 104729 + 1);
  const id = `${kind}-${seed}`;
  const base = { kind, id };
  switch (kind) {
    case "shape": {
      const shape = pick(r, SHAPES);
      const paint = pick(r, PAINT);
      const cv = new Canvas(SIZE, SIZE);
      draw(cv, shape, SIZE / 2, SIZE / 2, paint);
      const others = SHAPES.filter((s) => s !== shape);
      return { ...base, png: cv.png(), question: "What is the shape in this picture, and what colour is it? Answer in the form: <colour> <shape>.", expected: `${paint} ${shape}`, check: (a) => has(a, paint) && has(a, shape) && !others.some((o) => has(a, o)) && !PAINT.some((p) => p !== paint && has(a, p)) };
    }
    case "count": {
      const shape = pick(r, SHAPES);
      const paint = pick(r, PAINT);
      const n = 1 + Math.floor(r() * 7);
      const other = n === 1 ? 3 : Math.floor(r() * 4);
      const cells = shuffle(r, [...Array(GRID * GRID).keys()]);
      const cv = new Canvas(SIZE, SIZE);
      const rest = PAINT.filter((p) => p !== paint);
      for (let i = 0; i < n; i++) draw(cv, shape, ...cellCentre(cells[i] as number), paint);
      for (let i = 0; i < other; i++) draw(cv, pick(r, SHAPES), ...cellCentre(cells[n + i] as number), pick(r, rest));
      // Other shapes in other colours may share the shape; what is counted is the colour and the shape together.
      return { ...base, png: cv.png(), question: `How many ${paint} ${shape}s are in this picture? Answer with just the number.`, expected: String(n), check: (a) => { const ns = numbersIn(a); return ns.length > 0 && ns.every((x) => x === n); } };
    }
    case "position": {
      const [a, b] = shuffle(r, PAINT);
      const [sa, sb] = [pick(r, SHAPES), pick(r, SHAPES)];
      const left = r() < 0.5;
      const cv = new Canvas(SIZE, SIZE);
      draw(cv, sa, left ? SIZE * 0.25 : SIZE * 0.75, SIZE / 2, a as Paint);
      draw(cv, sb, left ? SIZE * 0.75 : SIZE * 0.25, SIZE / 2, b as Paint);
      return { ...base, png: cv.png(), question: `One shape is ${a} and the other is ${b}. Which one is on the left? Answer with just the colour.`, expected: left ? (a as string) : (b as string), check: (x) => has(x, left ? (a as string) : (b as string)) && !has(x, left ? (b as string) : (a as string)) };
    }
    case "text": {
      const word = pick(r, WORDS);
      return { ...base, png: writing(r, word).png(), question: "What word is written in this picture? Answer with just the word.", expected: word, check: (a) => has(a, word) };
    }
    case "digits": {
      const n = String(1000 + Math.floor(r() * 9000));
      return { ...base, png: writing(r, n).png(), question: "What number is written in this picture? Answer with just the number.", expected: n, check: (a) => digitsIn(a.replace(/[,\s]/g, "")).includes(n) };
    }
    case "sum": {
      const x = 10 + Math.floor(r() * 40);
      const y = 10 + Math.floor(r() * 40);
      const s = `${x}+${y}`;
      return { ...base, png: writing(r, s).png(), question: "This picture shows a sum. What is its result? Answer with just the number.", expected: String(x + y), check: (a) => digitsIn(a).pop() === String(x + y) };
    }
  }
}

/** `count` scenarios of each kind, with seeds `seed`, `seed + 1`, ... */
export function scenarios(o: { kinds?: readonly Kind[] | undefined; count: number; seed: number }): Scenario[] {
  return (o.kinds ?? KINDS).flatMap((k) => Array.from({ length: o.count }, (_, i) => make(k, o.seed + i)));
}
