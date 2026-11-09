import { open } from "node:fs/promises";
import { modelSource, type ModelEntry, type Sampling } from "./config.ts";
import { listRepoFiles, pickGguf } from "./hf.ts";
import { fetchFollow, fetchJson, type FetchFn } from "./net.ts";

/**
 * Where a model's sampling comes from when the settings do not say (docs/local-models.md, section 5), in this order, the first that
 * has any values being used whole: the settings, `general.sampling.*` in the GGUF header, the base model's `generation_config.json`
 * (found through the Hugging Face API's `base_model`), nothing. Nothing is applied silently: the caller shows `source`.
 */

export type SamplingSource = "settings" | "gguf" | "generation_config";

export interface ResolvedSampling {
  values: Sampling;
  /** Where the values came from; undefined when there are none. */
  source: SamplingSource | undefined;
  /** A line saying which file or repository, for people. */
  detail: string | undefined;
  /** What could not be looked up (the network, a missing file), never fatal. */
  notes: string[];
}

export interface SamplingOptions {
  fetch?: FetchFn | undefined;
  token?: string | undefined;
  hfBase?: string | undefined;
  /** The model's GGUF file when it is on disk: read instead of asking the network. */
  localFile?: string | undefined;
  signal?: AbortSignal | undefined;
}

// ---- the GGUF header

/** A way to read bytes `[start, start + length)` of the file; may return fewer at its end. */
export type RangeReader = (start: number, length: number) => Promise<Uint8Array>;

export const fileReader = (path: string): RangeReader => async (start, length) => {
  const f = await open(path, "r");
  try {
    const buf = new Uint8Array(length);
    const { bytesRead } = await f.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await f.close();
  }
};

export const urlReader = (url: string, o: { fetch?: FetchFn | undefined; token?: string | undefined; signal?: AbortSignal | undefined }): RangeReader => async (start, length) => {
  const res = await fetchFollow(url, { fetch: o.fetch, token: o.token, signal: o.signal, headers: { range: `bytes=${start}-${start + length - 1}` } });
  if (res.status === 416) return new Uint8Array(0);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A server that ignores Range sends the whole file from the start; never use more than was asked.
  if (res.status === 200) return bytes.subarray(start, start + length);
  return bytes.subarray(0, length);
};

/** The most of the header read before giving up: the tokenizer's vocabulary is most of it, a few megabytes. */
const HEADER_LIMIT = 48 * 1024 * 1024;
const CHUNK = 1024 * 1024;

class Cursor {
  buf = new Uint8Array(0);
  pos = 0;
  readonly read: RangeReader;
  constructor(read: RangeReader) {
    this.read = read;
  }
  async need(n: number): Promise<void> {
    while (this.buf.length - this.pos < n) {
      if (this.buf.length >= HEADER_LIMIT) throw new Error("the header is larger than expected");
      const more = await this.read(this.buf.length, Math.max(CHUNK, n));
      if (more.length === 0) throw new Error("the file ended inside its header");
      const next = new Uint8Array(this.buf.length + more.length);
      next.set(this.buf);
      next.set(more, this.buf.length);
      this.buf = next;
    }
  }
  async bytes(n: number): Promise<DataView> {
    await this.need(n);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, n);
    this.pos += n;
    return v;
  }
  async skip(n: number): Promise<void> {
    await this.need(n);
    this.pos += n;
  }
  async u32(): Promise<number> {
    return (await this.bytes(4)).getUint32(0, true);
  }
  async u64(): Promise<number> {
    const n = (await this.bytes(8)).getBigUint64(0, true);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("a length in the header is too large");
    return Number(n);
  }
  async string(): Promise<string> {
    const len = await this.u64();
    if (len > 1 << 24) throw new Error("a string in the header is too long");
    await this.need(len);
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
}

const FIXED: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

async function value(c: Cursor, type: number): Promise<number | string | boolean | undefined> {
  const size = FIXED[type];
  if (size !== undefined) {
    const v = await c.bytes(size);
    switch (type) {
      case 0: return v.getUint8(0);
      case 1: return v.getInt8(0);
      case 2: return v.getUint16(0, true);
      case 3: return v.getInt16(0, true);
      case 4: return v.getUint32(0, true);
      case 5: return v.getInt32(0, true);
      case 6: return v.getFloat32(0, true);
      case 7: return v.getUint8(0) !== 0;
      case 10: return Number(v.getBigUint64(0, true));
      case 11: return Number(v.getBigInt64(0, true));
      default: return v.getFloat64(0, true);
    }
  }
  if (type === 8) return await c.string();
  if (type === 9) {
    const inner = await c.u32();
    const n = await c.u64();
    const w = FIXED[inner];
    if (w !== undefined) await c.skip(n * w);
    else for (let i = 0; i < n; i++) await value(c, inner);
    return undefined;
  }
  throw new Error(`unknown value type ${type} in the header`);
}

/** The `general.sampling.*` keys of a GGUF file's header as sampling settings. Throws when the bytes are not a GGUF header. */
export async function readGgufSampling(read: RangeReader): Promise<Sampling> {
  const c = new Cursor(read);
  const magic = await c.bytes(4);
  if (String.fromCharCode(magic.getUint8(0), magic.getUint8(1), magic.getUint8(2), magic.getUint8(3)) !== "GGUF") throw new Error("not a GGUF file");
  const version = await c.u32();
  if (version < 2 || version > 3) throw new Error(`GGUF version ${version} is not one this reads`);
  await c.u64(); // tensors
  const count = await c.u64();
  const found: Record<string, number> = {};
  for (let i = 0; i < count; i++) {
    const key = await c.string();
    const type = await c.u32();
    const v = await value(c, type);
    if (key.startsWith("general.sampling.") && typeof v === "number") found[key.slice("general.sampling.".length)] = v;
  }
  return fromGguf(found);
}

/** llama.cpp's key names (`temp`, `penalty_repeat`) as ours. */
function fromGguf(f: Record<string, number>): Sampling {
  const out: Sampling = {};
  if (f["temp"] !== undefined) out.temperature = round(f["temp"]);
  if (f["top_p"] !== undefined) out.top_p = round(f["top_p"]);
  if (f["top_k"] !== undefined) out.top_k = Math.round(f["top_k"]);
  if (f["min_p"] !== undefined) out.min_p = round(f["min_p"]);
  if (f["penalty_repeat"] !== undefined) out.repeat_penalty = round(f["penalty_repeat"]);
  return out;
}

/** Floats are stored as 32 bits: 0.6 reads back as 0.6000000238418579. */
const round = (n: number): number => Number(n.toPrecision(7));

// ---- the base model's generation_config.json

const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function fromGenerationConfig(json: unknown): Sampling {
  if (typeof json !== "object" || json === null) return {};
  const g = json as Record<string, unknown>;
  const out: Sampling = {};
  const t = asNumber(g["temperature"]);
  const p = asNumber(g["top_p"]);
  const k = asNumber(g["top_k"]);
  if (t !== undefined && t >= 0 && t <= 5) out.temperature = t;
  if (p !== undefined && p >= 0 && p <= 1) out.top_p = p;
  if (k !== undefined && k >= 0 && Number.isInteger(k)) out.top_k = k;
  return out;
}

/** The repositories a Hugging Face repository says it was made from: `cardData.base_model` (a name or a list), else a `base_model:` tag. */
export function baseModels(info: unknown): string[] {
  if (typeof info !== "object" || info === null) return [];
  const i = info as Record<string, unknown>;
  const card = (i["cardData"] as Record<string, unknown> | undefined)?.["base_model"];
  const fromCard = (Array.isArray(card) ? card : [card]).filter((x): x is string => typeof x === "string" && /^[\w.-]+\/[\w.-]+$/.test(x));
  if (fromCard.length > 0) return fromCard;
  const tags = Array.isArray(i["tags"]) ? (i["tags"] as unknown[]) : [];
  const out: string[] = [];
  for (const t of tags) {
    const m = typeof t === "string" ? /^base_model:(?:[a-z]+:)?([\w.-]+\/[\w.-]+)$/.exec(t) : null;
    if (m?.[1] !== undefined && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** How far up the chain of base models to look (a quantised copy of a re-upload of the original is two). */
const MAX_HOPS = 3;

async function baseGenerationConfig(repo: string, o: SamplingOptions, notes: string[]): Promise<{ repo: string; values: Sampling } | undefined> {
  const base = o.hfBase ?? "https://huggingface.co";
  const seen = new Set<string>([repo]);
  let queue = [repo];
  for (let hop = 0; hop < MAX_HOPS && queue.length > 0; hop++) {
    const next: string[] = [];
    for (const r of queue) {
      let info: unknown;
      try {
        info = await fetchJson(`${base}/api/models/${r}`, { fetch: o.fetch, token: o.token, signal: o.signal });
      } catch (e) {
        notes.push(`could not read ${r} on Hugging Face (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      for (const b of baseModels(info)) {
        if (seen.has(b)) continue;
        seen.add(b);
        try {
          const res = await fetchFollow(`${base}/${b}/resolve/main/generation_config.json`, { fetch: o.fetch, token: o.token, signal: o.signal });
          const values = fromGenerationConfig(await res.json());
          if (Object.keys(values).length > 0) return { repo: b, values };
        } catch {
          // No such file in that repository: look further up.
        }
        next.push(b);
      }
    }
    queue = next;
  }
  return undefined;
}

// ---- the whole lookup

/** The sampling for a model entry. Never throws: what could not be looked up is in `notes`. */
export async function resolveSampling(m: ModelEntry, o: SamplingOptions = {}): Promise<ResolvedSampling> {
  const notes: string[] = [];
  if (m.sampling !== undefined && Object.keys(m.sampling).length > 0) return { values: m.sampling, source: "settings", detail: "the settings file", notes };

  const src = modelSource(m);
  // 2. The GGUF header.
  try {
    let read: RangeReader | undefined;
    let where = "";
    if (o.localFile !== undefined) {
      read = fileReader(o.localFile);
      where = o.localFile;
    } else if (src?.kind === "url") {
      read = urlReader(src.url, o);
      where = src.url;
    } else if (src !== undefined) {
      const base = o.hfBase ?? "https://huggingface.co";
      let path = src.kind === "hf" ? src.file : undefined;
      if (path === undefined) {
        const files = await listRepoFiles(src.repo, src.revision, { fetch: o.fetch, token: o.token, base: o.hfBase });
        path = (pickGguf(files, src.kind === "hf-quant" ? src.quant : undefined, src.repo)[0] as { path: string }).path;
      }
      where = `${src.repo}/${path}`;
      read = urlReader(`${base}/${src.repo}/resolve/${encodeURIComponent(src.revision)}/${path.split("/").map(encodeURIComponent).join("/")}`, o);
    }
    if (read !== undefined) {
      const values = await readGgufSampling(read);
      if (Object.keys(values).length > 0) return { values, source: "gguf", detail: `general.sampling in ${where}`, notes };
    }
  } catch (e) {
    notes.push(`could not read the GGUF header (${e instanceof Error ? e.message : String(e)})`);
  }

  // 3. The base model's generation_config.json.
  if (src !== undefined && src.kind !== "url") {
    const g = await baseGenerationConfig(src.repo, o, notes);
    if (g !== undefined) return { values: g.values, source: "generation_config", detail: `generation_config.json of ${g.repo}`, notes };
  }
  return { values: {}, source: undefined, detail: undefined, notes };
}

/** The values as a settings snippet, for `models info` to offer. */
export function samplingYaml(name: string, s: Sampling): string {
  return [`local_models:`, `  models:`, `    ${name}:`, `      sampling: { ${Object.entries(s).map(([k, v]) => `${k}: ${v}`).join(", ")} }`].join("\n");
}
