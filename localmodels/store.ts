import { mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { hfUrl } from "./config.ts";
import { downloadFile, DownloadError } from "./download.ts";
import { linkedInfo, listRepoFiles, pickGguf, pickSidecar } from "./hf.ts";
import { Lock } from "./lock.ts";
import { resolveKey, sourceHash, type Download } from "./plan.ts";
import type { FetchFn } from "./net.ts";

/** The model files: pending Hugging Face quantisations turned into files, then every file fetched and recorded (docs/local-models.md, section 3). */

export type StoreEvent =
  | { type: "resolve"; model: string; what: string }
  | { type: "download"; model: string; role: Download["role"]; file: string; received: number; total: number | undefined }
  | { type: "have"; model: string; role: Download["role"]; file: string }
  | { type: "done"; model: string; role: Download["role"]; file: string; size: number };

export interface StoreOptions {
  lock: Lock;
  /** The data directory; lock keys are relative to it. */
  data: string;
  fetch?: FetchFn | undefined;
  token?: string | undefined;
  /** Another Hugging Face address (tests). */
  hfBase?: string | undefined;
  onEvent?: ((e: StoreEvent) => void) | undefined;
  signal?: AbortSignal | undefined;
}

const keyOf = (data: string, dest: string): string => dest.slice(data.length).replaceAll("\\", "/").replace(/^\/+/, "");
const isHf = (url: string): boolean => new URL(url).host === "huggingface.co";

/** Pending quantisations become files (one, or the parts of a split model). Anything else passes through. A quantisation seen before is not asked about again. */
export async function resolveDownloads(downloads: readonly Download[], o: StoreOptions): Promise<Download[]> {
  const out: Download[] = [];
  for (const d of downloads) {
    if (d.resolve === undefined) {
      out.push(d);
      continue;
    }
    const { repo, revision, quant, pick } = d.resolve;
    const qkey = resolveKey(d.resolve);
    let paths = o.lock.quant(qkey);
    let sizes = new Map<string, { size: number; sha256: string | undefined }>();
    if (paths === undefined) {
      o.onEvent?.({ type: "resolve", model: d.model, what: `${repo}${quant === undefined ? "" : `:${quant}`}` });
      const listed = await listRepoFiles(repo, revision, { fetch: o.fetch, token: o.token, base: o.hfBase });
      const files = pick === undefined ? pickGguf(listed, quant, repo) : [pickSidecar(listed, pick, quant, repo)];
      paths = files.map((f) => f.path);
      sizes = new Map(files.map((f) => [f.path, { size: f.size, sha256: f.sha256 }]));
      o.lock.setQuant(qkey, paths);
    }
    const { resolve: _pending, ...rest } = d;
    for (const path of paths) {
      const file = basename(path);
      const known = sizes.get(path);
      const url = hfUrl(repo, revision, path);
      out.push({
        ...rest,
        url,
        file,
        dest: `${d.dir}/${sourceHash(url)}/${file}`,
        sha256: paths.length === 1 ? (d.sha256 ?? known?.sha256) : known?.sha256,
        size: known?.size,
      });
    }
  }
  return out;
}

/**
 * Files used to be kept in `models/<name>/`. One that is recorded there, present at the recorded size, and not yet in its place is moved
 * there, so nothing is fetched again. A second model with the same file finds it already moved and has nothing to do (its copy under
 * `models/` is left for `pruneFiles`).
 */
async function bringAcross(d: Download, key: string, o: StoreOptions): Promise<void> {
  if (o.lock.file(key) !== undefined || d.file === undefined || d.dest === undefined) return;
  const legacyKey = `models/${d.model}/${basename(d.dest)}`;
  const old = o.lock.file(legacyKey);
  if (old === undefined) return;
  const from = `${o.data}/${legacyKey}`;
  if ((await stat(from).catch(() => undefined))?.size !== old.size) return;
  await mkdir(dirname(d.dest), { recursive: true });
  await rename(from, d.dest);
  o.lock.setFile(key, old);
  o.lock.deleteFile(legacyKey);
  await o.lock.save();
}

export interface Fetched {
  model: string;
  role: Download["role"];
  dest: string;
  sha256: string;
  size: number;
}

/** Every file, in order. A file that is recorded in the lock and present with the recorded size is not fetched and the network is not asked. */
export async function fetchDownloads(downloads: readonly Download[], o: StoreOptions): Promise<Fetched[]> {
  const out: Fetched[] = [];
  for (const d of downloads) {
    if (d.url === undefined || d.dest === undefined || d.file === undefined) throw new Error(`${d.model}: the download was not resolved`);
    const key = keyOf(o.data, d.dest);
    await bringAcross(d, key, o);
    const locked = o.lock.file(key);
    const present = (await stat(d.dest).catch(() => undefined))?.size;
    const pinned = d.sha256?.toLowerCase();
    if (locked !== undefined && present === locked.size && (pinned === undefined || pinned === locked.sha256)) {
      o.onEvent?.({ type: "have", model: d.model, role: d.role, file: d.file });
      out.push({ model: d.model, role: d.role, dest: d.dest, sha256: locked.sha256, size: locked.size });
      continue;
    }
    let expected = pinned;
    let size = d.size;
    if (expected === undefined && isHf(d.url)) {
      const info = await linkedInfo(d.url, { fetch: o.fetch, token: o.token });
      expected = info?.sha256;
      size ??= info?.size;
    }
    const got = await downloadFile({
      url: d.url,
      dest: d.dest,
      sha256: expected,
      size,
      token: isHf(d.url) ? o.token : undefined,
      fetch: o.fetch,
      signal: o.signal,
      onProgress: (p) => o.onEvent?.({ type: "download", model: d.model, role: d.role, file: d.file as string, received: p.received, total: p.total }),
    });
    o.lock.setFile(key, { sha256: got.sha256, size: got.size });
    await o.lock.save();
    o.onEvent?.({ type: "done", model: d.model, role: d.role, file: d.file, size: got.size });
    out.push({ model: d.model, role: d.role, dest: d.dest, sha256: got.sha256, size: got.size });
  }
  return out;
}

/** `name@hash8`: the model's identity in history (docs/local-models.md, section 1): the first eight hex digits of the SHA-256 of its first file. */
export const modelId = (name: string, fetched: readonly Fetched[]): string | undefined => {
  const f = fetched.find((x) => x.model === name && x.role === "model");
  return f === undefined ? undefined : `${name}@${f.sha256.slice(0, 8)}`;
};

export { DownloadError };
