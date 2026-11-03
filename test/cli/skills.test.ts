import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import type { Io } from "../../cli/io.ts";
import { findProject, openThread } from "../../cli/project.ts";
import { skillsWaiting } from "../../cli/skills.ts";
import { Conversation } from "../../harness/conversation.ts";
import { harnessConfig } from "../../harness/config.ts";
import { parseConfig } from "../../src/config.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, host, initArgs, testIo } from "./support.ts";

async function started(replies: Reply[]) {
  const server = await FakeServer.start(replies);
  const dir = join(await tempDir(), "p");
  const io = testIo(dir);
  assert.equal(await main(initArgs(server, dir), io), 0, io.stderr);
  return { server, dir };
}
async function session(dir: string, lines: string[], opts: { io?: Partial<Io> } = {}) {
  const io = testIo(dir, { stdin: `${lines.join("\n")}\n`, ...opts.io });
  const code = await main(["chat", "--plain", "-y"], io);
  return { code, out: io.stdout, err: io.stderr, all: `${io.stdout}${io.stderr}` };
}
type Msg = { role: string; content: string };
const sent = (server: FakeServer, n: number): Msg[] => (JSON.parse(server.seen[n]?.body ?? "") as { messages: Msg[] }).messages;
const system = (server: FakeServer, n: number): string => sent(server, n)[0]?.content ?? "";
const dialogue = (server: FakeServer, n: number): string => JSON.stringify(sent(server, n).slice(1));
const md = (name: string, description: string, body = `${name} body`): string => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
async function skill(dir: string, name: string, text: string, where = ".agents/skills"): Promise<void> {
  await mkdir(join(dir, where, name), { recursive: true });
  await writeFile(join(dir, where, name, "SKILL.md"), text);
}
const configure = (dir: string, follow: string): Promise<void> => appendFile(join(dir, "harness.yml"), `skills:\n  follow: ${follow}\n`);

describe("/skills and /skill", () => {
  test("/skills reports what is on disk; /skills sync pins it before the first request, so the catalog is in the prefix", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      await skill(dir, "greet", md("greet", "Say hello nicely", "Greet the user warmly, then ask their name."));
      await skill(dir, "bad-one", "no frontmatter here");
      const r = await session(dir, ["/skills", "/skills sync", "/skills", "/skills sync", "hello"]);
      assert.match(r.all, /no skills are pinned to this thread/);
      assert.match(r.all, /on disk: 1 added \(greet\); \/skills sync takes them \(skills\.follow is ask\)/);
      assert.match(r.all, /bad-one[\\/]SKILL\.md: it does not start with a ---/);
      assert.match(r.all, /skills updated: 1 added \(greet\)/);
      assert.match(r.out, /greet {2}\[in the catalog\] {2}Say hello nicely/, "no request has been made yet, so it went straight into the prefix");
      assert.match(r.all, /the skills are already what is on disk/);
      assert.match(system(server, 0), /\[Skills\][\s\S]*- greet: Say hello nicely/);
    } finally {
      await server.close();
    }
  });

  test("/skill sends the body (and the directory) as your message, with what you asked for", async () => {
    const { server, dir } = await started([answer("done")]);
    try {
      await skill(dir, "greet", md("greet", "Say hello", "Greet warmly."));
      const r = await session(dir, ["/skills sync", "/skill greet to the new colleague", "/skill nope", "/skill"]);
      assert.match(r.all, /there is no skill nope pinned to this thread/);
      assert.match(r.err, /which skill\?/);
      const last = sent(server, 0).at(-1)?.content ?? "";
      assert.equal(last, "[The user invoked the skill greet; follow it]\nSkill: greet\nDirectory: .agents/skills/greet (relative to the workspace). Files this skill mentions are in that directory.\n\nGreet warmly.\n\nThe user's request: to the new colleague");
      const entries = (await (await Conversation.open(host, dir)).readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
      assert.ok(entries.some((e) => e.$tag === "user" && e.content.some((c) => c.$tag === "text" && typeof c.text === "string" && c.text.startsWith("[The user invoked the skill greet"))), "recorded as a user entry");
    } finally {
      await server.close();
    }
  });

  test("/skill on a skill that is only on disk says how to pin it", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      await skill(dir, "later", md("later", "d"));
      const r = await session(dir, ["/skill later"]);
      assert.match(r.err, /there is no skill later pinned to this thread/);
      assert.match(r.err, /it is on disk: \/skills sync pins it/);
      assert.equal(server.seen.length, 0);
    } finally {
      await server.close();
    }
  });

  test("the user-level directory is searched (CHATTREE_SKILLS_DIR); a project skill of the same name wins; a link out of the skill is refused", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      const user = join(await tempDir(), "user-skills");
      await skill(user, "shared", md("shared", "user version", "user body"), ".");
      await skill(user, "mine", md("mine", "only mine"), ".");
      await skill(dir, "shared", md("shared", "project version", "project body"));
      await writeFile(join(dir, "outside.md"), md("leaky", "outside", "secret"));
      await mkdir(join(dir, ".agents", "skills", "leaky"), { recursive: true });
      await symlink(join(dir, "outside.md"), join(dir, ".agents", "skills", "leaky", "SKILL.md"));
      const r = await session(dir, ["/skills sync", "/skills"], { io: { env: { CHATTREE_SKILLS_DIR: user } } });
      assert.match(r.out, /mine {2}\[in the catalog\] {2}only mine/);
      assert.match(r.out, /shared {2}\[in the catalog\] {2}project version/);
      assert.doesNotMatch(r.out, /leaky {2}\[/);
      assert.match(r.err, /link that leaves the skill's directory/);
    } finally {
      await server.close();
    }
  });
});

describe("following the disk", () => {
  test("ask (the default): a change is reported once and nothing is recorded until /skills sync; then the model is told where, the prefix is untouched", async () => {
    const { server, dir } = await started([answer("one"), answer("two"), answer("three")]);
    try {
      await skill(dir, "first", md("first", "The first skill"));
      const r = await session(dir, ["/skills sync", "hello", "/rebuild", "/skills", "go on"]);
      assert.ok(r.code === 0);
      // new session: the disk changes between turns
      await skill(dir, "second", md("second", "A skill added later", "second body"));
      await skill(dir, "first", md("first", "The first skill", "first body, edited"));
      const r2 = await session(dir, ["again", "once more", "/skills sync", "/skills", "last"]);
      assert.match(r2.out, /first {2}\[in the catalog \(older text; the model was told of the change\)\]/);
      assert.match(r2.out, /second {2}\[announced only \(not in the catalog until \/rebuild\)\]/);
      assert.match(r2.all, /skills changed on disk: 1 added \(second\), 1 changed \(first\); \/skills sync takes them/);
      assert.equal((r2.all.match(/skills changed on disk/g) ?? []).length, 1, "the same report is not repeated");
      const before = dialogue(server, server.seen.length - 3);
      assert.doesNotMatch(before, /skills changed/, "nothing is told until the change is pinned");
      const lastN = server.seen.length - 1;
      assert.equal(system(server, lastN), system(server, lastN - 1), "the cached prefix is untouched");
      assert.doesNotMatch(system(server, lastN), /second/);
      assert.match(dialogue(server, lastN), /The skills changed[\s\S]*Added:\\n- second: A skill added later\\nChanged[\s\S]*- first: The first skill/);
      assert.match(r2.all, /skills updated: 1 added \(second\), 1 changed \(first\)/);
    } finally {
      await server.close();
    }
  });

  test("auto: the change is pinned at the start of the next request, as an append", async () => {
    const { server, dir } = await started([answer("one"), answer("two")]);
    try {
      await configure(dir, "auto");
      await skill(dir, "first", md("first", "The first skill"));
      const r = await session(dir, ["hello"]);
      assert.match(r.all, /skills followed the disk: 1 added \(first\)/);
      assert.match(system(server, 0), /- first: The first skill/, "before the first request it goes into the prefix");
      await skill(dir, "second", md("second", "Added while running"));
      await rm(join(dir, ".agents", "skills", "first"), { recursive: true });
      const r2 = await session(dir, ["again"]);
      assert.match(r2.all, /skills followed the disk: 1 added \(second\), 1 removed \(first\)/);
      assert.equal(system(server, 1), system(server, 0));
      assert.match(dialogue(server, 1), /Added:\\n- second: Added while running\\nRemoved \(the skill tool no longer serves these\):\\n- first/);
      const setup = await (await Conversation.open(host, dir)).setup();
      assert.deepEqual(Object.keys(setup.skills), ["second"]);
      assert.deepEqual(Object.keys(setup.prefix.skills).sort(), ["first"], "the old catalog line stays until a rebuild");
    } finally {
      await server.close();
    }
  });

  test("off: nobody looks; and an edit that breaks a skill does not remove it from the model", async () => {
    const { server, dir } = await started([answer("one"), answer("two"), answer("three")]);
    try {
      await skill(dir, "first", md("first", "The first skill"));
      await session(dir, ["/skills sync", "hello"]);
      await configure(dir, "off");
      await skill(dir, "second", md("second", "ignored"));
      const quiet = await session(dir, ["again"]);
      assert.doesNotMatch(quiet.all, /skills changed on disk|followed the disk/);
      assert.doesNotMatch(dialogue(server, 1), /skills changed/);
      // back to auto, with the first skill's file now unreadable
      await writeFile(join(dir, "harness.yml"), (await readFile(join(dir, "harness.yml"), "utf8")).replace("follow: off", "follow: auto"));
      await writeFile(join(dir, ".agents", "skills", "first", "SKILL.md"), "---\nname: first\n---\nbroken, no description\n");
      const r = await session(dir, ["third", "/skills"]);
      assert.match(r.all, /skills followed the disk: 1 added \(second\)/);
      assert.doesNotMatch(r.all, /removed \(first\)/);
      assert.match(r.err, /no description/);
      assert.match(r.out, /first {2}\[in the catalog\]/);
    } finally {
      await server.close();
    }
  });

  test("removal: the notice says so, /skills shows the old line is still in the catalog, /rebuild drops it", async () => {
    const { server, dir } = await started([answer("one"), answer("two"), answer("three")]);
    try {
      await skill(dir, "gone", md("gone", "Soon gone"));
      await skill(dir, "stay", md("stay", "Stays"));
      await session(dir, ["/skills sync", "hello"]);
      await rm(join(dir, ".agents", "skills", "gone"), { recursive: true });
      const r = await session(dir, ["/skills sync", "/skills", "again", "/rebuild", "/skills", "last"]);
      assert.match(r.out, /gone {2}\[removed, still in the catalog until \/rebuild\]/);
      assert.match(system(server, 1), /- gone: Soon gone/);
      assert.match(dialogue(server, 1), /Removed \(the skill tool no longer serves these\):\\n- gone/);
      assert.doesNotMatch(system(server, 2), /gone/);
      assert.match(system(server, 2), /- stay: Stays/);
    } finally {
      await server.close();
    }
  });

  test("without the skill tool in harness.yml the model is not shown a catalog it could not use, and /skills says why", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      await writeFile(join(dir, "harness.yml"), (await readFile(join(dir, "harness.yml"), "utf8")).replace("  skill:\n    allow: { all: 2999-01-01 }\n", ""));
      await skill(dir, "greet", md("greet", "Say hello"));
      const r = await session(dir, ["/skills sync", "hello", "/skills"]);
      assert.doesNotMatch(system(server, 0), /greet/);
      assert.match(r.err, /the skill tool is not enabled/);
    } finally {
      await server.close();
    }
  });
});

describe("the status line and the setting", () => {
  test("the status line counts skills that changed on disk when the policy is ask, and says nothing otherwise", async () => {
    const { server, dir } = await started([answer("ok")]);
    try {
      const io = testIo(dir);
      const project = await findProject(io, dir);
      const opened = await openThread(io, project);
      try {
        assert.equal(await skillsWaiting(io, project, opened.convo), 0);
        await skill(dir, "a", md("a", "d"));
        await skill(dir, "b", md("b", "d"));
        assert.equal(await skillsWaiting(io, project, opened.convo), 2);
        await configure(dir, "auto");
        const again = await openThread(io, project);
        assert.equal(await skillsWaiting(io, project, again.convo), 0, "auto takes them with the next request; nobody needs telling");
        await again.convo.close();
      } finally {
        await opened.convo.close();
      }
    } finally {
      await server.close();
    }
  });

  test("skills.follow is auto, ask or off; anything else is refused", async () => {
    const ok = await parseConfig("skills:\n  follow: auto\n", harnessConfig);
    assert.ok(ok.ok && ok.value.skills.follow === "auto");
    assert.ok((await parseConfig("providers: {}\n", harnessConfig)).ok && ((await parseConfig("providers: {}\n", harnessConfig)) as { value: { skills: { follow: string } } }).value.skills.follow === "ask");
    assert.ok(!(await parseConfig("skills:\n  follow: sometimes\n", harnessConfig)).ok);
  });
});
