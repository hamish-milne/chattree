import { loadConfigDocument } from "../src/config.ts";
import type { BlobStore } from "../src/index.ts";
import type { Host } from "../src/host.ts";
import type { Conversation } from "./conversation.ts";
import { hashDefinition, loadPinned, pinDefinition, type DefinitionSource } from "./definitions.ts";
import type { ChatEntry } from "./entries.ts";
import type { Renderer, SkillNote } from "./renderer.ts";
import { foldSetup, stable, type AgentSetup, type PinnedDefinition } from "./setup.ts";

/**
 * Skills (docs/context.md, section 2): the Agent Skills layout, a directory holding `SKILL.md` with `name` and `description` in
 * its YAML frontmatter. The pinned unit is the whole `SKILL.md` as a `SkillValue` (kind `skill`), so what the model was
 * shown is reproducible from the transcript whatever happens to the file later.
 *
 * A skill file is untrusted data: anyone who can put a file in a repository can put one here. The loader reads it bounded,
 * never follows a link out of the skill's directory, and skips (and reports) what it cannot make sense of instead of failing the scan.
 */

export const SKILL_FILE = "SKILL.md";
/** Limits that keep a hostile or careless skill from filling the context or the scan. */
export const MAX_SKILL_BYTES = 64 * 1024;
export const MAX_FRONTMATTER_BYTES = 8 * 1024;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;
export const MAX_META_BYTES = 4 * 1024;
export const MAX_SKILLS_PER_ROOT = 200;
/** What the catalog in the prefix shows: at most this many lines, each description cut to this many characters. */
export const CATALOG_MAX_SKILLS = 50;
export const CATALOG_MAX_DESCRIPTION = 200;

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The pinned form of a skill. `meta` holds the frontmatter keys other than `name` and `description`; `dir` says where the bundled files are. */
export interface SkillValue {
  name: string;
  description: string;
  body: string;
  meta?: Record<string, unknown>;
  /** The skill's directory: relative to the project root for a project skill, absolute for a user-level one. Part of the pin. */
  dir?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `v` as a skill, or undefined when it does not have the shape (a pin of another kind, or damaged). */
export function asSkill(v: unknown): SkillValue | undefined {
  if (!isRecord(v) || typeof v["name"] !== "string" || typeof v["description"] !== "string" || typeof v["body"] !== "string") return undefined;
  return { name: v["name"], description: v["description"], body: v["body"], ...(isRecord(v["meta"]) ? { meta: v["meta"] } : {}), ...(typeof v["dir"] === "string" ? { dir: v["dir"] } : {}) };
}

export type ParsedSkill = { ok: true; value: SkillValue } | { ok: false; problem: string };

/**
 * Read the text of a `SKILL.md`. `dirName` is the name of the directory it was in: the skill's `name` must equal it, so a name never
 * depends on which of two files is found first. A problem is a sentence for the person who wrote the file.
 */
export function parseSkillText(text: string, dirName: string): ParsedSkill {
  const bad = (problem: string): ParsedSkill => ({ ok: false, problem });
  const t = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!t.startsWith("---\n")) return bad("it does not start with a --- frontmatter block holding name and description");
  const close = /\n---[ \t]*(\n|$)/.exec(t.slice(3));
  if (close === null) return bad("the frontmatter is not closed with a --- line");
  const front = t.slice(4, 3 + close.index + 1);
  const body = t.slice(3 + close.index + close[0].length).replace(/^\n+/, "").replace(/\s+$/, "");
  if (new TextEncoder().encode(front).length > MAX_FRONTMATTER_BYTES) return bad(`the frontmatter is longer than ${MAX_FRONTMATTER_BYTES} bytes`);
  const { doc, issues } = loadConfigDocument(front);
  if (issues.length > 0) return bad(`the frontmatter is not valid YAML: ${issues[0]?.message ?? "unreadable"}`);
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 0 });
  } catch (e) {
    return bad(`the frontmatter is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isRecord(data)) return bad("the frontmatter must be a map with name and description");
  const { name, description, ...rest } = data;
  if (typeof name !== "string" || name.trim() === "") return bad("the frontmatter has no name");
  if (typeof description !== "string" || description.trim() === "") return bad("the frontmatter has no description");
  if (name.length > MAX_NAME || !NAME_RE.test(name)) return bad(`the name ${JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}...` : name)} must be lowercase letters, digits and hyphens, at most ${MAX_NAME} long`);
  if (name !== dirName) return bad(`the name ${name} does not match its directory ${dirName}`);
  if (description.length > MAX_DESCRIPTION) return bad(`the description is longer than ${MAX_DESCRIPTION} characters`);
  if (body === "") return bad("there is nothing after the frontmatter: a skill needs instructions");
  if (stable(rest).length > MAX_META_BYTES) return bad(`the other frontmatter keys are longer than ${MAX_META_BYTES} characters`);
  return { ok: true, value: { name, description: description.trim(), body, ...(Object.keys(rest).length > 0 ? { meta: rest } : {}) } };
}

/** A place skills are searched: `path` is the directory of skill directories, `dir` how a skill under it is named in its pin (a prefix, or absolute when undefined). */
export interface SkillRoot {
  path: string;
  prefix?: string;
}

export interface SkillScan {
  skills: Record<string, SkillValue>;
  /** One sentence per skill that was skipped or hidden, naming the file. */
  problems: string[];
  /** Directories whose skill could not be read: what is pinned under that name is left alone, not treated as removed. */
  unreadable: Set<string>;
}

const within = (host: Host, root: string, p: string): boolean => {
  const rel = host.path.relative(root, p);
  return rel !== ".." && !rel.startsWith("..") && !host.path.isAbsolute(rel);
};

/**
 * Where skills live for a project: the user's directory, then `.agents/skills` and `.chattree/skills` of the project root.
 * Later roots win a name collision, so a project's own skill replaces a user's of the same name.
 */
export function skillRoots(host: Host, projectRoot: string, userDir: string | undefined): SkillRoot[] {
  return [
    ...(userDir === undefined ? [] : [{ path: userDir }]),
    { path: host.path.join(projectRoot, ".agents", "skills"), prefix: ".agents/skills" },
    { path: host.path.join(projectRoot, ".chattree", "skills"), prefix: ".chattree/skills" },
  ];
}

/** The user-level skills directory: `CHATTREE_SKILLS_DIR`, else `chattree/skills` under the user's config directory. Undefined when there is no way to tell. */
export function userSkillsDir(host: Host, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const set = env["CHATTREE_SKILLS_DIR"];
  if (set !== undefined && set !== "") return host.path.resolve(set);
  const base = host.platform === "windows" ? env["APPDATA"] : (env["XDG_CONFIG_HOME"] ?? (env["HOME"] === undefined || env["HOME"] === "" ? undefined : host.path.join(env["HOME"], ".config")));
  return base === undefined || base === "" ? undefined : host.path.join(base, "chattree", "skills");
}

/** Read every skill under the roots. Never throws for a bad skill: it is skipped and named in `problems`. */
export async function scanSkills(host: Host, roots: readonly SkillRoot[]): Promise<SkillScan> {
  const scan: SkillScan = { skills: {}, problems: [], unreadable: new Set() };
  const origin = new Map<string, string>();
  const dec = new TextDecoder("utf-8", { fatal: true });
  for (const root of roots) {
    const st = await host.fs.stat(root.path).catch(() => undefined);
    if (st === undefined) continue;
    if (!st.isDirectory) {
      scan.problems.push(`${root.path} is not a directory`);
      continue;
    }
    let names: string[];
    try {
      names = (await host.fs.readdir(root.path)).filter((n) => !n.startsWith(".")).sort();
    } catch (e) {
      scan.problems.push(`${root.path} cannot be listed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (names.length > MAX_SKILLS_PER_ROOT) {
      scan.problems.push(`${root.path} has ${names.length} entries; only the first ${MAX_SKILLS_PER_ROOT} are looked at`);
      names = names.slice(0, MAX_SKILLS_PER_ROOT);
    }
    for (const dirName of names) {
      const dir = host.path.join(root.path, dirName);
      const file = host.path.join(dir, SKILL_FILE);
      try {
        if ((await host.fs.stat(dir))?.isDirectory !== true) continue;
        const fst = await host.fs.stat(file);
        if (fst === undefined) continue; // a directory that is not a skill
        const fail = (why: string): void => {
          scan.problems.push(`${file}: ${why}`);
          scan.unreadable.add(dirName);
        };
        if (!fst.isFile) {
          fail("not a regular file");
          continue;
        }
        // A link may point anywhere: the body must come from inside the skill's own directory.
        const realDir = await host.fs.realpath(dir);
        const realFile = await host.fs.realpath(file);
        if (realDir === undefined || realFile === undefined || !within(host, realDir, realFile)) {
          fail("it is a link that leaves the skill's directory, so it was not read");
          continue;
        }
        if (fst.size > MAX_SKILL_BYTES) {
          fail(`it is ${fst.size} bytes; the limit is ${MAX_SKILL_BYTES}`);
          continue;
        }
        let text: string;
        try {
          text = dec.decode(await host.fs.readRange(file, 0, MAX_SKILL_BYTES + 1));
        } catch {
          fail("it is not valid UTF-8 text");
          continue;
        }
        const parsed = parseSkillText(text, dirName);
        if (!parsed.ok) {
          fail(parsed.problem);
          continue;
        }
        const earlier = origin.get(dirName);
        if (earlier !== undefined) scan.problems.push(`${file} replaces the skill ${dirName} found at ${earlier}`);
        origin.set(dirName, file);
        scan.unreadable.delete(dirName);
        scan.skills[dirName] = { ...parsed.value, dir: root.prefix === undefined ? dir : `${root.prefix}/${dirName}` };
      } catch (e) {
        scan.problems.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
        scan.unreadable.add(dirName);
      }
    }
  }
  return scan;
}

export const pinSkill = (value: SkillValue, blobs: BlobStore): Promise<PinnedDefinition> => pinDefinition("skill", value, { store: "blob", blobs });

/** How the skills on disk differ from the pinned ones. */
export interface SkillDrift {
  added: string[];
  changed: string[];
  removed: string[];
}

export const driftSize = (d: SkillDrift): number => d.added.length + d.changed.length + d.removed.length;

/**
 * Compare what the setup pinned with a scan. A pinned skill whose file could not be read (`unreadable`) is left alone: a typo in
 * an edit must not remove the skill from the model.
 */
export async function skillDrift(pinned: Readonly<Record<string, PinnedDefinition>>, scan: SkillScan): Promise<SkillDrift> {
  const out: SkillDrift = { added: [], changed: [], removed: [] };
  for (const [name, value] of Object.entries(scan.skills)) {
    const pin = pinned[name];
    if (pin === undefined) out.added.push(name);
    else if (pin.hash !== (await hashDefinition("skill", value))) out.changed.push(name);
  }
  for (const name of Object.keys(pinned)) if (scan.skills[name] === undefined && !scan.unreadable.has(name)) out.removed.push(name);
  for (const l of [out.added, out.changed, out.removed]) l.sort();
  return out;
}

/**
 * Make the pinned skills what the scan found: a setup change that touches nothing but skills, which is an `append` once a request has
 * been made (the model is told where it was made) and goes straight into the prefix before that. Resolves to what changed, or undefined.
 */
export async function syncSkills(convo: Conversation, scan: SkillScan): Promise<SkillDrift | undefined> {
  const drift = await skillDrift((await convo.setup()).skills, scan);
  if (driftSize(drift) === 0) return undefined;
  const set: Record<string, PinnedDefinition> = {};
  for (const name of [...drift.added, ...drift.changed]) set[name] = await pinSkill(scan.skills[name] as SkillValue, convo.store);
  await convo.setupChange({ skills: { ...(Object.keys(set).length > 0 ? { set } : {}), ...(drift.removed.length > 0 ? { remove: drift.removed } : {}) } });
  return drift;
}

/** The text a skill is served as (by the `skill` tool and `/skill`): the directory when it has one, then the body. */
export function skillText(v: SkillValue): string {
  const where = v.dir === undefined ? "" : `Directory: ${v.dir}${v.dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v.dir) ? "" : " (relative to the workspace)"}. Files this skill mentions are in that directory.\n`;
  return `Skill: ${v.name}\n${where}\n${v.body}`;
}

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** The skills as the catalog lists them: sorted by name, capped in number, descriptions on one line and cut. */
export function catalogNotes(skills: Readonly<Record<string, unknown>>): { notes: SkillNote[]; omitted: number } {
  const all = Object.keys(skills).sort().flatMap((n) => {
    const v = asSkill(skills[n]);
    return v === undefined ? [] : [{ name: v.name, description: oneLine(v.description, CATALOG_MAX_DESCRIPTION) }];
  });
  return { notes: all.slice(0, CATALOG_MAX_SKILLS), omitted: Math.max(0, all.length - CATALOG_MAX_SKILLS) };
}

/** The catalog the cached prefix carries after the instructions, or undefined when there is nothing to list. */
export function skillCatalog(render: Renderer, prefixSkills: Readonly<Record<string, unknown>>): string | undefined {
  const { notes, omitted } = catalogNotes(prefixSkills);
  return notes.length === 0 ? undefined : render.skillCatalog(notes, omitted);
}

/** The instructions the model's prefix shows, with the catalog after them. */
export const withCatalog = (instructions: string | undefined, catalog: string | undefined): string | undefined => (catalog === undefined ? instructions : instructions === undefined ? catalog : `${instructions}\n\n${catalog}`);

/** What the model is told about a skills change appended where it was made. */
export interface SkillsUpdate {
  added: SkillNote[];
  changed: SkillNote[];
  removed: string[];
}

/**
 * For each `append` setup entry that changed skills (see `pendingAppends`): what to tell the model. Whether a skill is added or
 * changed is judged against the setup before that entry, which is what the model has been told so far.
 */
export async function skillUpdates(entries: readonly ChatEntry[], pending: readonly Extract<ChatEntry, { $tag: "agent_setup" }>[], from: { blobs: BlobStore; source?: DefinitionSource }): Promise<Map<string, SkillsUpdate>> {
  const out = new Map<string, SkillsUpdate>();
  for (const e of pending) {
    if (e.skills === undefined) continue;
    const before = foldSetup(entries.slice(0, entries.indexOf(e))).skills;
    const update: SkillsUpdate = { added: [], changed: [], removed: [...(e.skills.remove ?? [])].sort() };
    for (const [name, pin] of Object.entries(e.skills.set ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const v = asSkill(await loadPinned("skill", name, pin, from));
      const note = { name, description: oneLine(v?.description ?? "", CATALOG_MAX_DESCRIPTION) };
      (before[name] === undefined ? update.added : update.changed).push(note);
    }
    out.set(e.id, update);
  }
  return out;
}

/** The catalog is shown only to a model that has the `skill` tool: otherwise it would list what it cannot read. */
export const hasSkillTool = (setup: AgentSetup): boolean => setup.tools["skill"] !== undefined;
