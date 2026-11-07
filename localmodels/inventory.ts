import { rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { modelSource, type LocalModels } from "./config.ts";
import type { Lock } from "./lock.ts";
import { downloadList, modelDir } from "./plan.ts";

/** What is on disk for each configured model, from the settings and the lock alone: no network, no running host (docs/local-models.md, section 3). */

export interface ModelFile {
  file: string;
  role: "model" | "mmproj";
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

export async function inventory(config: LocalModels, lock: Lock, data: string): Promise<ModelInfo[]> {
  const { downloads } = downloadList(config, { join }, data);
  const out: ModelInfo[] = [];
  for (const name of Object.keys(config.models).sort()) {
    const m = config.models[name] as LocalModels["models"][string];
    const files: ModelFile[] = [];
    let complete = true;
    for (const d of downloads.filter((x) => x.model === name)) {
      let wanted: { file: string; dest: string }[];
      if (d.resolve !== undefined) {
        const paths = lock.quant(`${d.resolve.repo}@${d.resolve.revision}:${d.resolve.quant ?? ""}`);
        wanted = (paths ?? []).map((p) => ({ file: basename(p), dest: join(d.dir, basename(p)) }));
        if (paths === undefined) complete = false;
      } else wanted = [{ file: d.file as string, dest: d.dest as string }];
      for (const w of wanted) {
        const key = w.dest.slice(data.length).replaceAll("\\", "/").replace(/^\/+/, "");
        const locked = lock.file(key);
        const size = (await stat(w.dest).catch(() => undefined))?.size;
        if (locked !== undefined && size === locked.size) files.push({ file: w.file, role: d.role, dest: w.dest, size, sha256: locked.sha256 });
        else complete = false;
      }
    }
    const first = files.filter((f) => f.role === "model").sort((a, b) => a.file.localeCompare(b.file))[0];
    out.push({ name, source: sourceText(m), files, complete: complete && files.length > 0, id: first === undefined ? undefined : `${name}@${first.sha256.slice(0, 8)}` });
  }
  return out;
}

/** Delete a model's downloaded files and forget them in the lock, so they are fetched again the next time they are wanted. */
export async function removeModelFiles(config: LocalModels, lock: Lock, data: string, name: string): Promise<{ files: number; bytes: number }> {
  const recorded = lock.filesUnder(`models/${name}/`);
  await rm(modelDir({ join }, data, name), { recursive: true, force: true });
  for (const [key] of recorded) lock.deleteFile(key);
  const m = config.models[name];
  const src = m === undefined ? undefined : modelSource(m);
  if (src?.kind === "hf-quant") lock.deleteQuant(`${src.repo}@${src.revision}:${src.quant ?? ""}`);
  await lock.save();
  return { files: recorded.length, bytes: recorded.reduce((n, [, f]) => n + f.size, 0) };
}
