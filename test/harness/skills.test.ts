import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { hashDefinition } from "../../harness/definitions.ts";
import { chattreeEnglishV1 } from "../../harness/renderer.ts";
import {
  CATALOG_MAX_DESCRIPTION,
  CATALOG_MAX_SKILLS,
  MAX_SKILL_BYTES,
  catalogNotes,
  driftSize,
  parseSkillText,
  scanSkills,
  skillCatalog,
  skillDrift,
  skillRoots,
  skillText,
  userSkillsDir,
  withCatalog,
  type SkillValue,
} from "../../harness/skills.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const md = (name: string, description: string, body = "Do the thing.", extra = ""): string => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;

async function skillDir(root: string, name: string, text: string, files: Record<string, string> = {}): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), text);
  for (const [f, c] of Object.entries(files)) await writeFile(join(dir, f), c);
  return dir;
}

describe("parseSkillText", () => {
  test("reads name, description and body; other keys are kept as metadata", () => {
    const r = parseSkillText(md("pdf-tools", "Work with PDFs", "Step 1.\n\nStep 2.", "license: MIT\nmetadata:\n  author: me\n"), "pdf-tools");
    assert.ok(r.ok);
    assert.deepEqual(r.value, { name: "pdf-tools", description: "Work with PDFs", body: "Step 1.\n\nStep 2.", meta: { license: "MIT", metadata: { author: "me" } } });
  });

  test("CRLF files and a byte order mark are read like any other", () => {
    const r = parseSkillText(`﻿${md("a", "d", "body line").replace(/\n/g, "\r\n")}`, "a");
    assert.ok(r.ok);
    assert.equal(r.value.body, "body line");
  });

  test("each way a file can be wrong is a sentence, never a throw", () => {
    const problem = (text: string, dir = "a"): string => {
      const r = parseSkillText(text, dir);
      assert.ok(!r.ok, text);
      return r.problem;
    };
    assert.match(problem("# just markdown"), /does not start with a ---/);
    assert.match(problem("---\nname: a\ndescription: d\n"), /not closed/);
    assert.match(problem("---\ndescription: d\n---\nbody"), /no name/);
    assert.match(problem("---\nname: a\n---\nbody"), /no description/);
    assert.match(problem("---\nname: a\ndescription: \"  \"\n---\nbody"), /no description/);
    assert.match(problem("---\nname: 12\ndescription: d\n---\nbody"), /no name/);
    assert.match(problem(md("Bad_Name", "d"), "Bad_Name"), /lowercase letters, digits and hyphens/);
    assert.match(problem(md("a", "d"), "b"), /does not match its directory b/);
    assert.match(problem(md("a", "x".repeat(1025))), /description is longer/);
    assert.match(problem("---\nname: a\ndescription: d\n---\n\n  \n"), /nothing after the frontmatter/);
    assert.match(problem("---\n- a\n- b\n---\nbody"), /must be a map/);
    assert.match(problem("---\nname: a\ndescription: [unclosed\n---\nbody"), /not valid YAML/);
    assert.match(problem("---\nname: a\ndescription: &x d\nother: *x\n---\nbody"), /not valid YAML/);
    assert.match(problem(`---\nname: a\ndescription: d\nbig: ${"z".repeat(9000)}\n---\nbody`), /frontmatter is longer/);
    assert.match(problem(`---\nname: a\ndescription: d\n${Array.from({ length: 300 }, (_, i) => `k${i}: ${"v".repeat(20)}`).join("\n")}\n---\nbody`), /frontmatter is longer|other frontmatter keys/);
  });
});

describe("scanSkills", () => {
  test("finds skills in every root; a later root wins a name, and says so", async () => {
    const base = await tempDir();
    const user = join(base, "user");
    const agents = join(base, "p", ".agents", "skills");
    const own = join(base, "p", ".chattree", "skills");
    await skillDir(user, "only-user", md("only-user", "from the user"));
    await skillDir(user, "both", md("both", "user version", "user body"));
    await skillDir(agents, "both", md("both", "agents version", "agents body"), { "helper.py": "print(1)" });
    await skillDir(own, "both", md("both", "own version", "own body"));
    await skillDir(agents, "tool", md("tool", "a tool"));
    await mkdir(join(agents, "no-skill-here"), { recursive: true });
    await writeFile(join(agents, "README.md"), "not a skill");
    const scan = await scanSkills(host, skillRoots(host, join(base, "p"), user));
    assert.deepEqual(Object.keys(scan.skills).sort(), ["both", "only-user", "tool"]);
    assert.equal(scan.skills["both"]?.body, "own body");
    assert.equal(scan.skills["both"]?.dir, ".chattree/skills/both", "a project skill's directory is relative to the project root");
    assert.equal(scan.skills["tool"]?.dir, ".agents/skills/tool");
    assert.equal(scan.skills["only-user"]?.dir, join(user, "only-user"), "a user-level skill's directory is absolute");
    assert.equal(scan.problems.filter((p) => /replaces the skill both/.test(p)).length, 2);
  });

  test("a missing root is fine; a bad skill is skipped and named, the rest still load", async () => {
    const base = await tempDir();
    const root = join(base, "skills");
    await skillDir(root, "good", md("good", "fine"));
    await skillDir(root, "nofront", "just text\n");
    await skillDir(root, "mismatch", md("other", "wrong dir"));
    await skillDir(root, "bad-yaml", "---\nname: [\n---\nbody");
    const big = await skillDir(root, "big", md("big", "too large", "x".repeat(MAX_SKILL_BYTES)));
    await skillDir(root, "binary", "---\nname: binary\n");
    await writeFile(join(root, "binary", "SKILL.md"), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]));
    const scan = await scanSkills(host, [{ path: join(base, "missing") }, { path: root, prefix: "skills" }]);
    assert.deepEqual(Object.keys(scan.skills), ["good"]);
    assert.equal(scan.problems.length, 5);
    assert.ok(scan.problems.some((p) => p.includes(join(big, "SKILL.md")) && /the limit is/.test(p)));
    assert.ok(scan.problems.some((p) => /mismatch.*does not match its directory mismatch/.test(p)));
    assert.ok(scan.problems.some((p) => /not valid UTF-8/.test(p)));
    assert.deepEqual([...scan.unreadable].sort(), ["bad-yaml", "big", "binary", "mismatch", "nofront"]);
  });

  test("a SKILL.md that is a link out of the skill's directory is not read; a link inside is", async () => {
    const base = await tempDir();
    const root = join(base, "skills");
    await writeFile(join(base, "secret.md"), md("leak", "outside the skill", "secret body"));
    await mkdir(join(root, "leak"), { recursive: true });
    await symlink(join(base, "secret.md"), join(root, "leak", "SKILL.md"));
    await mkdir(join(root, "inside"), { recursive: true });
    await writeFile(join(root, "inside", "real.md"), md("inside", "a link within", "inner body"));
    await symlink(join(root, "inside", "real.md"), join(root, "inside", "SKILL.md"));
    const scan = await scanSkills(host, [{ path: root, prefix: "skills" }]);
    assert.deepEqual(Object.keys(scan.skills), ["inside"]);
    assert.match(scan.problems.join("\n"), /link that leaves the skill's directory/);
    assert.ok(!JSON.stringify(scan).includes("secret body"));
  });

  test("more entries than the limit are not all read", async () => {
    const base = await tempDir();
    const root = join(base, "skills");
    for (let i = 0; i < 205; i++) await skillDir(root, `s${String(i).padStart(3, "0")}`, md(`s${String(i).padStart(3, "0")}`, "d"));
    const scan = await scanSkills(host, [{ path: root, prefix: "skills" }]);
    assert.equal(Object.keys(scan.skills).length, 200);
    assert.match(scan.problems[0] ?? "", /205 entries; only the first 200/);
  });
});

describe("the user-level directory", () => {
  test("CHATTREE_SKILLS_DIR wins, then the config directory; nothing when the environment says nothing", () => {
    assert.equal(userSkillsDir(host, { CHATTREE_SKILLS_DIR: "/x/skills", HOME: "/h" }), "/x/skills");
    assert.equal(userSkillsDir(host, { XDG_CONFIG_HOME: "/cfg", HOME: "/h" }), join("/cfg", "chattree", "skills"));
    assert.equal(userSkillsDir(host, { HOME: "/h" }), join("/h", ".config", "chattree", "skills"));
    assert.equal(userSkillsDir(host, {}), undefined);
    assert.equal(userSkillsDir(host, { HOME: "" }), undefined);
  });
});

describe("pinned form and drift", () => {
  const value = (over: Partial<SkillValue> = {}): SkillValue => ({ name: "a", description: "d", body: "b", dir: ".agents/skills/a", ...over });

  test("the hash covers the body, the description and the directory", async () => {
    const h = (v: SkillValue): Promise<string> => hashDefinition("skill", v);
    const base = await h(value());
    assert.equal(await h(value()), base);
    for (const over of [{ body: "b2" }, { description: "d2" }, { dir: ".chattree/skills/a" }, { meta: { x: 1 } }]) assert.notEqual(await h(value(over)), base, JSON.stringify(over));
  });

  test("drift: added, changed, removed; an unreadable file leaves the pinned skill alone", async () => {
    const pin = async (v: SkillValue) => ({ hash: await hashDefinition("skill", v), store: "blob" as const });
    const pinned = { same: await pin(value({ name: "same" })), edited: await pin(value({ name: "edited" })), gone: await pin(value({ name: "gone" })), broken: await pin(value({ name: "broken" })) };
    const scan = { skills: { same: value({ name: "same" }), edited: value({ name: "edited", body: "new" }), fresh: value({ name: "fresh" }) }, problems: [], unreadable: new Set(["broken"]) };
    const d = await skillDrift(pinned, scan);
    assert.deepEqual(d, { added: ["fresh"], changed: ["edited"], removed: ["gone"] });
    assert.equal(driftSize(d), 3);
  });

  test("skillText names the directory so read and run can reach bundled files", () => {
    assert.equal(skillText(value()), "Skill: a\nDirectory: .agents/skills/a (relative to the workspace). Files this skill mentions are in that directory.\n\nb");
    assert.match(skillText(value({ dir: "/home/u/.config/chattree/skills/a" })), /^Skill: a\nDirectory: \/home\/u\/\.config\/chattree\/skills\/a\. Files/);
    assert.equal(skillText({ name: "a", description: "d", body: "b" }), "Skill: a\n\nb");
  });
});

describe("the catalog", () => {
  test("one line per skill, sorted, descriptions on one line and cut; capped in number", () => {
    const skills: Record<string, unknown> = { zed: { name: "zed", description: "last", body: "b" }, alpha: { name: "alpha", description: `multi\n  line ${"x".repeat(300)}`, body: "b" }, junk: 5 };
    const { notes, omitted } = catalogNotes(skills);
    assert.deepEqual(notes.map((n) => n.name), ["alpha", "zed"], "a value that is not a skill is left out");
    assert.equal(notes[0]?.description.length, CATALOG_MAX_DESCRIPTION);
    assert.ok(notes[0]?.description.startsWith("multi line xxx") && notes[0].description.endsWith("…"));
    assert.equal(omitted, 0);
    const many = Object.fromEntries(Array.from({ length: CATALOG_MAX_SKILLS + 7 }, (_, i) => [`s${String(i).padStart(3, "0")}`, { name: `s${String(i).padStart(3, "0")}`, description: "d", body: "b" }]));
    const c = catalogNotes(many);
    assert.equal(c.notes.length, CATALOG_MAX_SKILLS);
    assert.equal(c.omitted, 7);
    assert.match(skillCatalog(chattreeEnglishV1, many) ?? "", /\(7 more are not listed here/);
  });

  test("nothing to list is no catalog, and the catalog follows the instructions", () => {
    assert.equal(skillCatalog(chattreeEnglishV1, {}), undefined);
    assert.equal(withCatalog("be brief", "CAT"), "be brief\n\nCAT");
    assert.equal(withCatalog(undefined, "CAT"), "CAT");
    assert.equal(withCatalog("be brief", undefined), "be brief");
  });
});
