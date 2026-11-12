import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { LocalModels } from "./config.ts";
import type { Lock } from "./lock.ts";
import { downloadList, resolveKey, sourceHash } from "./plan.ts";
import { hfUrl } from "./config.ts";

/** What is on disk for each configured model, from the settings and the lock alone: no network, no running host (docs/local-models.md, section 3). */

export interface ModelFile {
  file: string;
  role: "model" | "mmproj" | "draft";
  dest: string;
  size: number;
  sha256: string;
}

export interface ModelInfo {
  name: string;
  /** Where it comes from, as the settings say it. */
  source: string;
  /** The files that are downloaded and recorded. */
  files: ModelFile[];
  /** False when a file the model needs is not there, or a quantisation has not been looked up yet. */
  complete: boolean;
  /** `name@hash8`, once the model file is there. */
  id: string | undefined;
}

const sourceText = (m: LocalModels["models"][string]): string => (m.url ?? `hf:${m.hf as string}${m.file === undefined ? "" : ` ${m.file}`}${m.revision === "main" ? "" : `@${m.revision}`}`);

const keyOf = (data: string, dest: string): string => dest.slice(data.length).replaceAll("\\", "/").replace(/^\/+/, "");

interface Wanted {
  role: "model" | "mmproj" | "draft";
  file: string;
  dest: string;
  key: string;
}

/** The files each configured model calls for, from the settings and the lock (a quantisation not looked up yet has none, and `looked` is false). */
function wantedFiles(config: LocalModels, lock: Lock, data: string): Map<string, { files: Wanted[]; looked: boolean; resolved: string[] }> {
  const { downloads } = downloadList(config, { join }, data);
  const out = new Map<string, { files: Wanted[]; looked: boolean; resolved: string[] }>();
  for (const name of Object.keys(config.models)) {
    const files: Wanted[] = [];
    const resolved: string[] = [];
    let looked = true;
    for (const d of downloads.filter((x) => x.model === name)) {
      if (d.resolve !== undefined) {
        resolved.push(resolveKey(d.resolve));
        const paths = lock.quant(resolveKey(d.resolve));
        if (paths === undefined) looked = false;
        for (const p of paths ?? []) {
          const dest = join(d.dir, sourceHash(hfUrl(d.resolve.repo, d.resolve.revision, p)), basename(p));
          files.push({ role: d.role, file: basename(p), dest, key: keyOf(data, dest) });
        }
      } else files.push({ role: d.role, file: d.file as string, dest: d.dest as string, key: keyOf(data, d.dest as string) });
    }
    out.set(name, { files, looked, resolved });
  }
  return out;
}

export async function inventory(config: LocalModels, lock: Lock, data: string): Promise<ModelInfo[]> {
  const wanted = wantedFiles(config, lock, data);
  const out: ModelInfo[] = [];
  for (const name of Object.keys(config.models).sort()) {
    const m = config.models[name] as LocalModels["models"][string];
    const w = wanted.get(name) as { files: Wanted[]; looked: boolean };
    const files: ModelFile[] = [];
    let complete = w.looked;
    for (const f of w.files) {
      const locked = lock.file(f.key);
      const size = (await stat(f.dest).catch(() => undefined))?.size;
      if (locked !== undefined && size === locked.size) files.push({ file: f.file, role: f.role, dest: f.dest, size, sha256: locked.sha256 });
      else complete = false;
    }
    const first = files.filter((f) => f.role === "model").sort((a, b) => a.file.localeCompare(b.file))[0];
    out.push({ name, source: sourceText(m), files, complete: complete && files.length > 0, id: first === undefined ? undefined : `${name}@${first.sha256.slice(0, 8)}` });
  }
  return out;
}

const dropEmpty = async (dir: string): Promise<void> => {
  if ((await readdir(dir).catch(() => ["x"])).length === 0) await rmdir(dir).catch(() => undefined);
};

/**
 * Delete a model's downloaded files and forget them in the lock, so they are fetched again the next time they are wanted. A file another
 * configured model also uses stays (it is not this model's alone), unless `shared` says to delete it too (`pull --force`, which fetches it again).
 */
export async function removeModelFiles(config: LocalModels, lock: Lock, data: string, name: string, o: { shared?: boolean } = {}): Promise<{ files: number; bytes: number; kept: number }> {
  const wanted = wantedFiles(config, lock, data);
  const others = new Set([...wanted].filter(([n]) => n !== name).flatMap(([, w]) => w.files.map((f) => f.key)));
  const mine = (wanted.get(name)?.files ?? []).map((f) => f.key);
  const legacy = lock.filesUnder(`models/${name}/`).map(([k]) => k);
  let files = 0;
  let bytes = 0;
  let kept = 0;
  for (const key of [...new Set([...mine, ...legacy])]) {
    if (o.shared !== true && others.has(key)) {
      kept++;
      continue;
    }
    const locked = lock.file(key);
    await rm(join(data, key), { force: true });
    await dropEmpty(join(data, key, ".."));
    if (locked !== undefined) {
      files++;
      bytes += locked.size;
      lock.deleteFile(key);
    }
  }
  const otherKeys = new Set([...wanted].filter(([n]) => n !== name).flatMap(([, w]) => w.resolved));
  for (const k of wanted.get(name)?.resolved ?? []) if (!otherKeys.has(k)) lock.deleteQuant(k);
  await lock.save();
  return { files, bytes, kept };
}

/** Delete every recorded file that no configured model uses (shared files that nobody refers to any more, copies left under `models/`). */
export async function pruneFiles(config: LocalModels, lock: Lock, data: string): Promise<{ files: number; bytes: number }> {
  const used = new Set([...wantedFiles(config, lock, data).values()].flatMap((w) => w.files.map((f) => f.key)));
  let files = 0;
  let bytes = 0;
  for (const [key, f] of [...lock.filesUnder("files/"), ...lock.filesUnder("models/")]) {
    if (used.has(key)) continue;
    await rm(join(data, key), { force: true });
    await dropEmpty(dirname(join(data, key)));
    lock.deleteFile(key);
    files++;
    bytes += f.size;
  }
  await lock.save();
  return { files, bytes };
}
