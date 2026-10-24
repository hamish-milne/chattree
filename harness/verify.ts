import { FrameError, ParseError, decodeSpan, scan, sha256Hex, type CommitInfo } from "../src/index.ts";
import { HostBlobStore } from "./blob-store.ts";
import { contextEntries } from "./context.ts";
import { CHAT_FILE, Conversation } from "./conversation.ts";
import { FORMAT, type ChatEntry } from "./entries.ts";

export interface Problem {
  severity: "error" | "warning";
  /** A stable identifier for the kind of problem. */
  code: string;
  message: string;
  commit?: string;
  /** The entry id, or `#<n>` (1-based position) for entries without one. */
  entry?: string;
}

export interface VerifyOptions {
  /** Branch, commit or ref to check. Default: HEAD. */
  rev?: string;
  /** Also read every historical version of the transcript and every blob, and compare bytes. Costs time proportional to the whole history. */
  deep?: boolean;
}

/**
 * Check a branch's history against every promise the format and the harness make. Returns problems instead of
 * throwing, so a damaged conversation can be examined. What is checked:
 *
 * - the transcript at the tip is well framed, canonical, and every entry validates against its schema;
 *   there is one header, of a supported format version; ids are unique
 * - along the first-parent chain, every commit's `Chattree-Offset` is the size of `chat.yml` at that commit,
 *   offsets never decrease, and a commit with an entry's trailers sits exactly on that entry's boundary with
 *   the same id and kind; commits without them (snapshots) do not change the transcript; every entry has
 *   exactly one commit
 * - merge commits for `subagent_result` / `fork_merge` have the entry's `tip` as second parent, and a fork or
 *   subagent start sits directly on its recorded fork point
 * - compactions can be applied, the `config_changed` hashes chain, and every blob an entry refers to exists
 * - with `deep`: each historical `chat.yml` is a byte prefix of the tip's, and each blob has the bytes its hash
 *   and size claim
 */
export async function verifyHistory(convo: Conversation, opts: VerifyOptions = {}): Promise<Problem[]> {
  const { git, pipeline } = convo;
  const rev = opts.rev ?? "HEAD";
  const problems: Problem[] = [];
  const add = (severity: Problem["severity"], code: string, message: string, extra: { commit?: string; entry?: string } = {}): void => {
    problems.push({ severity, code, message, ...(extra.commit === undefined ? {} : { commit: extra.commit }), ...(extra.entry === undefined ? {} : { entry: extra.entry }) });
  };

  const tipCommit = await git.revParse(rev);
  if (tipCommit === undefined) return [{ severity: "error", code: "no-such-revision", message: `${rev} does not exist` }];
  const tip = await git.readFileAt(tipCommit, CHAT_FILE);
  if (tip === undefined) return [{ severity: "error", code: "no-transcript", message: `${CHAT_FILE} does not exist at ${rev}`, commit: tipCommit }];

  // ---- the transcript at the tip ------------------------------------------------------------------------
  let framed;
  try {
    framed = scan(tip);
  } catch (e) {
    if (e instanceof FrameError) return [{ severity: "error", code: "frame", message: e.message, commit: tipCommit }];
    throw e;
  }
  if (framed.truncated) add("error", "truncated-tail", `${CHAT_FILE} ends with an incomplete entry`, { commit: tipCommit });

  const entries: { ok: boolean; id: string | undefined; tag: string | undefined; end: number; value?: ChatEntry }[] = [];
  const decodedValues: ChatEntry[] = [];
  const seen = new Set<string>();
  for (const [i, span] of framed.spans.entries()) {
    const label = `#${i + 1}`;
    let parsed;
    try {
      parsed = decodeSpan(tip, span);
    } catch (e) {
      if (e instanceof ParseError) {
        add("error", "not-canonical", `entry ${label}: ${e.message}`, { entry: label });
        entries.push({ ok: false, id: undefined, tag: undefined, end: span.end });
        continue;
      }
      throw e;
    }
    const r = await pipeline.decode(parsed);
    if (!r.ok) {
      add(r.reason === "unknown-tag" ? "warning" : "error", r.reason === "unknown-tag" ? "unknown-entry-type" : "invalid-entry", `entry ${label}: ${r.issues.map((x) => `${x.path || "entry"}: ${x.message}`).join("; ")}`, { entry: label });
      entries.push({ ok: false, id: undefined, tag: r.tag, end: span.end });
      continue;
    }
    const id = (r.value as { id?: string }).id;
    if (id !== undefined) {
      if (seen.has(id)) add("error", "duplicate-id", `entry id ${id} appears more than once`, { entry: id });
      seen.add(id);
    }
    entries.push({ ok: true, id, tag: r.tag, end: span.end, value: r.value });
    decodedValues.push(r.value);
  }

  const first = entries[0]?.value;
  if (entries.length > 0 && first?.$tag !== "header") add("error", "no-header", "the first entry is not a header", { entry: "#1" });
  entries.slice(1).forEach((e, i) => {
    if (e.tag === "header") add("error", "extra-header", "a header appears after the first entry", { entry: `#${i + 2}` });
  });
  if (first?.$tag === "header") {
    if (first.major !== FORMAT.major) add("error", "unsupported-format", `format major version ${first.major} is not supported (this build reads ${FORMAT.major})`, { entry: "#1" });
    else if (first.minor > FORMAT.minor) add("warning", "newer-format", `format ${first.major}.${first.minor} is newer than this build (${FORMAT.major}.${FORMAT.minor}); unknown fields are ignored`, { entry: "#1" });
  }

  // ---- the commits ----------------------------------------------------------------------------------------
  const commits = (await git.log(tipCommit, { firstParent: true })).reverse();
  const sizes = await git.objectInfo(commits.map((c) => `${c.hash}:${CHAT_FILE}`));
  const byEnd = new Map<number, number>();
  entries.forEach((e, i) => byEnd.set(e.end, i));
  const covered = new Set<number>();

  let prevOffset = 0;
  const entryCommitFor = new Map<number, CommitInfo>();
  for (const [i, c] of commits.entries()) {
    const kind = c.trailers["Chattree-Kind"]?.[0];
    const entryId = c.trailers["Chattree-Entry"]?.[0];
    const raw = c.trailers["Chattree-Offset"]?.[0];
    const offset = raw === undefined ? NaN : Number(raw);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      add("error", "missing-offset", `commit has no valid Chattree-Offset trailer (${raw ?? "absent"})`, { commit: c.hash });
      continue;
    }
    const size = sizes[i]?.size;
    if (size === undefined) add("error", "no-transcript-at-commit", `${CHAT_FILE} does not exist at this commit`, { commit: c.hash });
    else if (size !== offset) add("error", "offset-mismatch", `Chattree-Offset is ${offset} but ${CHAT_FILE} is ${size} bytes at this commit`, { commit: c.hash });
    if (offset < prevOffset) add("error", "offset-decreased", `the transcript shrank from ${prevOffset} to ${offset} bytes`, { commit: c.hash });

    if (kind === undefined) {
      if (offset !== prevOffset && i > 0) add("error", "unlabelled-transcript-change", "a commit without entry trailers changed the transcript", { commit: c.hash });
    } else {
      const idx = byEnd.get(offset);
      if (idx === undefined) {
        add("error", "offset-not-boundary", `Chattree-Offset ${offset} is not the end of any entry in the transcript`, { commit: c.hash });
      } else {
        const e = entries[idx] as (typeof entries)[number];
        if (covered.has(idx)) add("error", "entry-committed-twice", "two commits claim the same entry", { commit: c.hash });
        covered.add(idx);
        entryCommitFor.set(idx, c);
        if (e.tag !== undefined && e.tag !== kind) add("error", "kind-mismatch", `trailer says ${kind} but the entry is ${e.tag}`, { commit: c.hash, entry: e.id ?? `#${idx + 1}` });
        if ((e.id ?? undefined) !== entryId) add("error", "entry-id-mismatch", `trailer says ${entryId ?? "no id"} but the entry is ${e.id ?? "id-less"}`, { commit: c.hash, entry: e.id ?? `#${idx + 1}` });
        if (offset <= prevOffset) add("error", "entry-without-growth", "an entry commit did not grow the transcript", { commit: c.hash });
      }
    }
    prevOffset = offset;
  }
  for (const [i, e] of entries.entries()) {
    if (!covered.has(i)) add("error", "entry-without-commit", `entry #${i + 1} has no commit of its own`, { entry: e.id ?? `#${i + 1}` });
  }

  // ---- relationships between entries and commits ------------------------------------------------------------
  for (const [i, e] of entries.entries()) {
    const c = entryCommitFor.get(i);
    const v = e.value;
    if (v === undefined || c === undefined) continue;
    const label = e.id ?? `#${i + 1}`;
    if (v.$tag === "subagent_result" || v.$tag === "fork_merge") {
      if (c.parents.length >= 2) {
        if (c.parents[1] !== v.tip) add("error", "merge-parent-mismatch", `the entry says the child's tip is ${v.tip} but the merge commit's second parent is ${c.parents[1]}`, { commit: c.hash, entry: label });
      } else if (c.trailers["Chattree-Recovered"] !== undefined) {
        add("warning", "recovered-merge", "this merge was recovered after a crash and lacks the child as a second parent", { commit: c.hash, entry: label });
      } else {
        add("error", "merge-without-second-parent", `${v.$tag} is not a merge commit`, { commit: c.hash, entry: label });
      }
    }
    if (v.$tag === "branch_start" && c.parents[0] !== v.from.commit) {
      add("error", "fork-point-mismatch", `the entry says the branch started at ${v.from.commit} but its commit's parent is ${c.parents[0] ?? "none"}`, { commit: c.hash, entry: label });
    }
  }

  // ---- compactions and configuration ---------------------------------------------------------------------------
  for (const [i, e] of entries.entries()) {
    if (e.value?.$tag !== "compaction") continue;
    const upto = entries.slice(0, i + 1).flatMap((x) => (x.value === undefined ? [] : [x.value]));
    if (!contextEntries(upto).includes(e.value)) add("warning", "compaction-ignored", "this compaction cannot be applied (unknown ids, a range not entirely before it, or a range in another context) and has no effect", { entry: e.id ?? `#${i + 1}` });
  }
  let chain = await Conversation.emptyConfigHash();
  for (const [i, e] of entries.entries()) {
    if (e.value?.$tag !== "config_changed") continue;
    if (e.value.old !== chain) add("warning", "config-chain-broken", `old hash ${e.value.old.slice(0, 12)} is not the previous recorded hash ${chain.slice(0, 12)} (the file was changed outside the harness, or by a merge)`, { entry: e.id ?? `#${i + 1}` });
    chain = e.value.new;
  }

  // ---- blobs ---------------------------------------------------------------------------------------------------
  const wanted = new Map<string, { bytes: number; entry: string }>();
  const walk = (x: unknown, entry: string): void => {
    if (Array.isArray(x)) for (const y of x) walk(y, entry);
    else if (typeof x === "object" && x !== null) {
      const o = x as Record<string, unknown>;
      if (o["$tag"] === "blob" && typeof o["sha256"] === "string" && typeof o["bytes"] === "number") wanted.set(o["sha256"], { bytes: o["bytes"], entry });
      else for (const y of Object.values(o)) walk(y, entry);
    }
  };
  for (const [i, e] of entries.entries()) if (e.value !== undefined) walk(e.value, e.id ?? `#${i + 1}`);
  const hashes = [...wanted.keys()];
  const specs = hashes.map((h) => `${tipCommit}:${HostBlobStore.relativePath(h)}`);
  const blobInfo = await git.objectInfo(specs);
  const present: number[] = [];
  hashes.forEach((h, i) => {
    const w = wanted.get(h) as { bytes: number; entry: string };
    const info = blobInfo[i];
    if (info === undefined) add("error", "blob-missing", `blob ${h.slice(0, 12)} is referenced but not in the tree`, { commit: tipCommit, entry: w.entry });
    else if (info.size !== w.bytes) add("error", "blob-size", `blob ${h.slice(0, 12)} is ${info.size} bytes, the reference says ${w.bytes}`, { commit: tipCommit, entry: w.entry });
    else present.push(i);
  });

  if (opts.deep === true) {
    for (let at = 0; at < present.length; at += 200) {
      const chunk = present.slice(at, at + 200);
      const data = await git.readObjects(chunk.map((i) => specs[i] as string));
      for (const [k, i] of chunk.entries()) {
        const h = hashes[i] as string;
        const bytes = data[k];
        if (bytes === undefined || (await sha256Hex(bytes)) !== h) add("error", "blob-corrupt", `blob ${h.slice(0, 12)} does not match its hash`, { commit: tipCommit, entry: wanted.get(h)?.entry as string });
      }
    }
    for (let at = 0; at < commits.length; at += 100) {
      const chunk = commits.slice(at, at + 100);
      const data = await git.readObjects(chunk.map((c) => `${c.hash}:${CHAT_FILE}`));
      for (const [k, c] of chunk.entries()) {
        const bytes = data[k];
        if (bytes === undefined) continue; // reported above
        if (bytes.length > tip.length || !bytes.every((b, j) => b === tip[j])) add("error", "not-a-prefix", `${CHAT_FILE} at this commit is not a byte prefix of the tip's`, { commit: c.hash });
      }
    }
  }
  return problems;
}
