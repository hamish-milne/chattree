import { fetchFollow, fetchJson, type FetchFn } from "./net.ts";

/** Hugging Face (docs/local-models.md, section 2): which file a quantisation names, and the SHA-256 a file must have. */

export interface RepoFile {
  path: string;
  size: number;
  /** The file's SHA-256 (Hugging Face's `lfs.oid`). */
  sha256: string | undefined;
}

/** What a file's path says of its role beside a model: a multimodal projector, or a draft model (Gemma 4's `mtp-…` / `…-assistant` files). */
export const PROJECTOR = /mmproj/i;
export const DRAFT = /(^|[^a-z0-9])(mtp|assistant)([^a-z0-9]|$)/i;
export type SidecarKind = "mmproj" | "draft";

const PART = /-(\d{5})-of-(\d{5})\.gguf$/i;
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class QuantError extends Error {
  override name = "QuantError";
}

/**
 * The file (or the parts of a split file, in order) that a quantisation names. A quantisation matches as a whole word of the path:
 * `Q4_K` does not match `Q4_K_M`, and a folder named for it counts (`Q4_K_M/model-00001-of-00002.gguf`). Projector and draft files are never the model.
 */
export function pickGguf(files: readonly RepoFile[], quant: string | undefined, repo = "the repository"): RepoFile[] {
  const ggufs = files.filter((f) => /\.gguf$/i.test(f.path) && !PROJECTOR.test(f.path) && !DRAFT.test(f.path));
  const groups = new Map<string, RepoFile[]>();
  for (const f of ggufs) {
    const key = f.path.replace(PART, ".gguf");
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const names = [...groups.keys()].sort();
  let keys = names;
  if (quant !== undefined) {
    const re = new RegExp(`(^|[^a-z0-9])${escape(quant)}([^a-z0-9_]|$)`, "i");
    keys = names.filter((k) => re.test(k));
    if (keys.length === 0) throw new QuantError(`${repo} has no ${quant} file${names.length > 0 ? ` (it has: ${names.join(", ")})` : " (no .gguf files at all)"}`);
  } else if (names.length === 0) throw new QuantError(`${repo} has no .gguf files`);
  if (keys.length > 1) throw new QuantError(`${repo}${quant === undefined ? "" : `:${quant}`} matches more than one file (${keys.join(", ")}); name one with file:`);
  const parts = (groups.get(keys[0] as string) as RepoFile[]).slice().sort((a, b) => a.path.localeCompare(b.path));
  const first = parts[0] as RepoFile;
  if (PART.test(first.path)) {
    const count = Number(PART.exec(first.path)?.[2]);
    if (parts.length !== count || !/-00001-of-/.test(first.path)) throw new QuantError(`${repo}: ${keys[0]} is split into ${count} parts and only ${parts.length} are there`);
  }
  return parts;
}

/** How much a file name says it is a precision worth taking first: projectors in half precision, draft models in 8 bits (they are small and a low one costs acceptance). A file with no precision in its name ranks last. */
const PREFERRED: Record<SidecarKind, readonly RegExp[]> = {
  mmproj: [/(^|[^a-z0-9])f16([^a-z0-9]|$)/i, /(^|[^a-z0-9])bf16([^a-z0-9]|$)/i, /q8_0/i],
  draft: [/q8_0/i, /(^|[^a-z0-9])bf16([^a-z0-9]|$)/i, /(^|[^a-z0-9])f16([^a-z0-9]|$)/i],
};

/**
 * The projector or draft model file of a repository: the GGUF files that look like one (`PROJECTOR`, `DRAFT`), narrowed by a quantisation
 * when one is named, then the most preferred precision. Several files of the same rank are an error that lists them; nothing is guessed.
 */
export function pickSidecar(files: readonly RepoFile[], kind: SidecarKind, quant: string | undefined, repo = "the repository"): RepoFile {
  const re = kind === "mmproj" ? PROJECTOR : DRAFT;
  let found = files.filter((f) => /\.gguf$/i.test(f.path) && re.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  const what = kind === "mmproj" ? "projector" : "draft model";
  if (found.length === 0) throw new QuantError(`${repo} has no ${what} file (a .gguf with ${kind === "mmproj" ? "mmproj" : "mtp or assistant"} in its name); name one with file: or hf:`);
  if (quant !== undefined) {
    const q = new RegExp(`(^|[^a-z0-9])${escape(quant)}([^a-z0-9_]|$)`, "i");
    found = found.filter((f) => q.test(f.path));
    if (found.length === 0) throw new QuantError(`${repo} has no ${quant} ${what} file`);
  }
  const rank = (f: RepoFile): number => {
    const i = PREFERRED[kind].findIndex((p) => p.test(f.path));
    return i < 0 ? PREFERRED[kind].length : i;
  };
  const best = Math.min(...found.map(rank));
  const top = found.filter((f) => rank(f) === best);
  if (top.length > 1) throw new QuantError(`${repo} has more than one ${what} file (${top.map((f) => f.path).join(", ")}); name one with file:`);
  return top[0] as RepoFile;
}

const hex64 = (v: unknown): string | undefined => (typeof v === "string" && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : undefined);

/** A repository's files at a revision, with sizes and hashes. */
export async function listRepoFiles(repo: string, revision: string, o: { fetch?: FetchFn | undefined; token?: string | undefined; base?: string | undefined } = {}): Promise<RepoFile[]> {
  const base = o.base ?? "https://huggingface.co";
  const out: RepoFile[] = [];
  let url: string | undefined = `${base}/api/models/${repo}/tree/${encodeURIComponent(revision)}?recursive=1`;
  for (let page = 0; url !== undefined && page < 50; page++) {
    const res: Response = await fetchFollow(url, { fetch: o.fetch, token: o.token, headers: { accept: "application/json" } });
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) throw new QuantError(`${repo}: Hugging Face did not list the files`);
    for (const r of rows as Record<string, unknown>[]) {
      if (r["type"] !== "file" || typeof r["path"] !== "string") continue;
      const lfs = r["lfs"] as Record<string, unknown> | undefined;
      out.push({ path: r["path"], size: typeof r["size"] === "number" ? r["size"] : 0, sha256: hex64(lfs?.["oid"]) });
    }
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
    url = next?.[1];
  }
  return out;
}

/** The hash and size Hugging Face gives a file on the redirect from its `resolve` address (`x-linked-etag`, `x-linked-size`); undefined for a file stored without LFS. */
export async function linkedInfo(url: string, o: { fetch?: FetchFn | undefined; token?: string | undefined } = {}): Promise<{ sha256: string; size: number | undefined } | undefined> {
  const res = await fetchFollow(url, { fetch: o.fetch, token: o.token, method: "HEAD", manual: true });
  const sha = hex64((res.headers.get("x-linked-etag") ?? "").replace(/^W\//, "").replaceAll('"', ""));
  if (sha === undefined) return undefined;
  const size = res.headers.get("x-linked-size");
  return { sha256: sha, size: size === null ? undefined : Number(size) };
}

export { fetchJson };
