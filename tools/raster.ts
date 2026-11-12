import { deflateSync } from "node:zlib";

/**
 * A small image generator with no dependencies: filled shapes, block text, and a PNG encoder (node:zlib). It exists so that tests and probes
 * can make pictures on the fly whose content is known exactly (tools/vision-scenarios.ts), the same on every machine: no fonts to find, no
 * native library to install. The text is a 5x7 bitmap font drawn in large blocks, which is plain on purpose; it is what a model's character
 * reading is asked to do, not what a typeface looks like.
 */

export type Rgb = readonly [number, number, number];

export const COLORS = {
  red: [220, 30, 30],
  green: [30, 160, 60],
  blue: [30, 70, 220],
  yellow: [240, 200, 20],
  purple: [130, 40, 160],
  black: [20, 20, 20],
  white: [255, 255, 255],
} as const satisfies Record<string, Rgb>;

export class Canvas {
  readonly width: number;
  readonly height: number;
  /** RGB, row by row. */
  readonly pixels: Uint8Array;

  constructor(width: number, height: number, background: Rgb = COLORS.white) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
    this.fillRect(0, 0, width, height, background);
  }

  set(x: number, y: number, c: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.pixels[i] = c[0];
    this.pixels[i + 1] = c[1];
    this.pixels[i + 2] = c[2];
  }

  get(x: number, y: number): Rgb {
    const i = (y * this.width + x) * 3;
    return [this.pixels[i] as number, this.pixels[i + 1] as number, this.pixels[i + 2] as number];
  }

  fillRect(x: number, y: number, w: number, h: number, c: Rgb): void {
    for (let j = Math.max(0, Math.floor(y)); j < Math.min(this.height, Math.ceil(y + h)); j++) for (let i = Math.max(0, Math.floor(x)); i < Math.min(this.width, Math.ceil(x + w)); i++) this.set(i, j, c);
  }

  /** A disc of radius `r` centred on `cx`, `cy`. */
  fillCircle(cx: number, cy: number, r: number, c: Rgb): void {
    for (let j = Math.floor(cy - r); j <= Math.ceil(cy + r); j++) for (let i = Math.floor(cx - r); i <= Math.ceil(cx + r); i++) if ((i - cx) ** 2 + (j - cy) ** 2 <= r * r) this.set(i, j, c);
  }

  /** An upright triangle that fits a box of `size` centred on `cx`, `cy`: apex at the top, base at the bottom. */
  fillTriangle(cx: number, cy: number, size: number, c: Rgb): void {
    const top = cy - size / 2;
    for (let j = 0; j < size; j++) {
      const half = (j / size) * (size / 2);
      for (let i = Math.floor(cx - half); i <= Math.ceil(cx + half); i++) this.set(i, Math.floor(top + j), c);
    }
  }

  /** Block text in capitals, digits, `+`, `-` and space; `scale` pixels per font dot. Returns the width it took. */
  text(s: string, x: number, y: number, scale: number, c: Rgb): number {
    let at = x;
    for (const ch of s.toUpperCase()) {
      const glyph = FONT[ch];
      if (glyph === undefined) throw new Error(`the font has no ${JSON.stringify(ch)}`);
      glyph.forEach((row, j) => {
        for (let i = 0; i < 5; i++) if (row[i] === "#") this.fillRect(at + i * scale, y + j * scale, scale, scale, c);
      });
      at += 6 * scale;
    }
    return at - x - scale;
  }

  png(): Uint8Array {
    return encodePng(this.width, this.height, this.pixels);
  }
}

/** The width of `s` in font dots (a one-dot gap between characters), for fitting text to a picture. */
export const textDots = (s: string): number => Math.max(0, s.length * 6 - 1);

// ---- the font ---------------------------------------------------------------------------------------------------------

const g = (...rows: string[]): readonly string[] => rows;
export const FONT: Readonly<Record<string, readonly string[]>> = {
  " ": g(".....", ".....", ".....", ".....", ".....", ".....", "....."),
  "+": g(".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."),
  "-": g(".....", ".....", ".....", "#####", ".....", ".....", "....."),
  "0": g(".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."),
  "1": g("..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."),
  "2": g(".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"),
  "3": g("#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."),
  "4": g("...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."),
  "5": g("#####", "#....", "####.", "....#", "....#", "#...#", ".###."),
  "6": g("..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."),
  "7": g("#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."),
  "8": g(".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."),
  "9": g(".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."),
  A: g(".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
  B: g("####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."),
  C: g(".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."),
  D: g("####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."),
  E: g("#####", "#....", "#....", "####.", "#....", "#....", "#####"),
  F: g("#####", "#....", "#....", "####.", "#....", "#....", "#...."),
  G: g(".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."),
  H: g("#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
  I: g(".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."),
  J: g("..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."),
  K: g("#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"),
  L: g("#....", "#....", "#....", "#....", "#....", "#....", "#####"),
  M: g("#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"),
  N: g("#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"),
  O: g(".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."),
  P: g("####.", "#...#", "#...#", "####.", "#....", "#....", "#...."),
  Q: g(".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"),
  R: g("####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"),
  S: g(".####", "#....", "#....", ".###.", "....#", "....#", "####."),
  T: g("#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."),
  U: g("#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."),
  V: g("#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."),
  W: g("#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"),
  X: g("#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"),
  Y: g("#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."),
  Z: g("#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"),
};

// ---- PNG ---------------------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 8-bit RGB, no interlacing. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height); // each row starts with its filter byte, 0 (none)
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
