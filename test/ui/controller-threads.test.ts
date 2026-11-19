import assert from "node:assert/strict";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runInit } from "../../app/init.ts";
import { Conversation } from "../../harness/conversation.ts";
import { nodeHost } from "../../hosts/node.ts";
import { Controller } from "../../ui/controller/controller.ts";
import type { Platform } from "../../ui/controller/platform.ts";
import { ChatModel } from "../../ui/model/chat-model.ts";
import { parseEvent, type UiEvent } from "../../ui/model/protocol.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const say = (text: string) => ({ $tag: "user" as const, content: [{ $tag: "text" as const, text }] });

async function rig() {
  const dir = await tempDir();
  const project = join(dir, "p");
  const env = { host, cwd: dir, env: { CHATTREE_ENVIRONMENT: "off", CHATTREE_SETTINGS: join(dir, "s.yml") }, now: Date.now };
  await runInit(env, { dir: project, provider: "none" });
  const opened: unknown[] = [];
  const copied: string[] = [];
  const platform: Platform = {
    openFile: (f) => {
      opened.push(f);
      return Promise.resolve();
    },
    copy: (t) => {
      copied.push(t);
      return Promise.resolve();
    },
    pickFiles: () => Promise.resolve([]),
  };
  const events: UiEvent[] = [];
  const view = new ChatModel(() => {});
  const c = new Controller({
    env,
    folders: [project],
    platform,
    session: "test",
    send: (e) => {
      const r = parseEvent(e);
      assert.ok(r.ok, JSON.stringify(r));
      events.push(e);
      view.apply(e);
    },
  });
  c.handle({ type: "ready", view: "graph" });
  c.handle({ type: "ready", view: "chat" });
  await c.idle();
  events.length = 0;
  const graph = () => events.findLast((e) => e.type === "graph.data");
  const threads = () => {
    const g = graph();
    return g?.type === "graph.data" ? g.data.threads : [];
  };
  const notice = () => {
    const n = events.findLast((e) => e.type === "notice");
    return n?.type === "notice" ? n.message : "";
  };
  const talk = async (...texts: string[]) => {
    const convo = await Conversation.open(host, project);
    const out = [];
    for (const t of texts) out.push(await convo.append(say(t)));
    await convo.close();
    return out;
  };
  return { c, dir, project, events, view, graph, threads, notice, talk, opened, copied };
}

describe("the controller, threads", () => {
  test("a new thread is a branch with a worktree of its own, opened in the chat; names count up", async () => {
    const { c, project, events, view, threads } = await rig();
    c.handle({ type: "thread.new" });
    await c.idle();
    assert.deepEqual(
      threads()
        .map((t) => t.name)
        .sort(),
      ["main", "thread/1"],
    );
    assert.equal(view.thread.value?.name, "thread/1");
    assert.deepEqual(
      events.findLast((e) => e.type === "graph.selected"),
      { type: "graph.selected", thread: "thread/1" },
    );
    c.handle({ type: "thread.new", name: "ideas" });
    c.handle({ type: "thread.new" });
    await c.idle();
    assert.deepEqual(
      threads()
        .map((t) => t.name)
        .sort(),
      ["ideas", "main", "thread/1", "thread/2"],
    );
    assert.ok((await stat(join(project, ".chattree", "threads", "ideas", "chat.yml"))).isFile());
    await c.close();
  });

  test("a fork starts from a commit: it has the history up to there and no more", async () => {
    const { c, view, talk, threads } = await rig();
    const [one] = await talk("one", "two");
    c.handle({ type: "thread.fork", thread: "main", commit: one!.commit, name: "side" });
    await c.idle();
    assert.equal(view.thread.value?.name, "side");
    assert.deepEqual(
      view.blocks.value.filter((b) => b.type === "user").map((b) => (b as { text: string }).text),
      ["one"],
    );
    assert.equal(threads().find((t) => t.name === "side")?.kind, "fork");
    await c.close();
  });

  test("going back keeps what came after under a ref, and the chat shows the earlier state", async () => {
    const { c, project, view, talk, notice } = await rig();
    const [one] = await talk("one", "two");
    c.handle({ type: "thread.rewind", thread: "main", commit: one!.commit });
    await c.idle();
    assert.deepEqual(
      view.blocks.value.filter((b) => b.type === "user").map((b) => (b as { text: string }).text),
      ["one"],
    );
    assert.match(notice(), /Went back/);
    const refs = await (await Conversation.open(host, project)).git.run(["for-each-ref", "refs/chattree/undone"]);
    assert.match(new TextDecoder().decode(refs.stdout), /undone\/main/);
    await c.close();
  });

  test("merging a fork brings its files and records the merge; the fork is then marked merged", async () => {
    const { c, project, dir, view, threads } = await rig();
    c.handle({ type: "thread.new", name: "work" });
    await c.idle();
    const worktree = join(project, ".chattree", "threads", "work");
    const convo = await Conversation.open(host, worktree);
    await writeFile(join(worktree, "notes.md"), "from the fork\n");
    await convo.append(say("make notes"));
    await convo.close();
    c.handle({ type: "thread.merge", from: "work", into: "main" });
    await c.idle();
    assert.equal(await readFile(join(project, "notes.md"), "utf8"), "from the fork\n");
    assert.equal(threads().find((t) => t.name === "work")?.merged, true);
    assert.ok(dir.length > 0);
    c.handle({ type: "thread.open", thread: "main" });
    await c.idle();
    assert.ok(view.blocks.value.some((b) => b.type === "notice" && b.kind === "merge"));
    await c.close();
  });

  test("archiving puts a thread away and brings it back; the main thread cannot be", async () => {
    const { c, threads, notice } = await rig();
    c.handle({ type: "thread.new", name: "idea" });
    await c.idle();
    c.handle({ type: "thread.archive", thread: "idea" });
    await c.idle();
    assert.equal(threads().find((t) => t.name === "idea")?.archived, true);
    c.handle({ type: "thread.unarchive", thread: "idea" });
    await c.idle();
    assert.equal(threads().find((t) => t.name === "idea")?.archived, undefined);
    c.handle({ type: "thread.archive", thread: "main" });
    await c.idle();
    assert.match(notice(), /main thread cannot be put away/);
    await c.close();
  });

  test("deleting removes the branch and its worktree; the main thread and the checked-out one are refused; the chat moves off a deleted thread", async () => {
    const { c, project, view, threads, notice } = await rig();
    c.handle({ type: "thread.new", name: "gone" });
    await c.idle();
    assert.equal(view.thread.value?.name, "gone");
    c.handle({ type: "thread.delete", thread: "gone" });
    await c.idle();
    assert.deepEqual(
      threads().map((t) => t.name),
      ["main"],
    );
    assert.equal(view.thread.value?.name, "main");
    await assert.rejects(stat(join(project, ".chattree", "threads", "gone")));
    c.handle({ type: "thread.delete", thread: "main" });
    await c.idle();
    assert.match(notice(), /cannot be deleted/);
    await c.close();
  });

  test("a harness.yml nobody approved raises the banner, and trusting it takes the banner away", async () => {
    const { c, project, view } = await rig();
    await appendFile(join(project, "harness.yml"), "# edited by hand\n");
    c.handle({ type: "thread.open", thread: "main" });
    await c.idle();
    assert.deepEqual(view.banner.value, { kind: "untrusted", state: "changed" });
    c.handle({ type: "thread.trust", thread: "main" });
    await c.idle();
    assert.notEqual(view.banner.value?.kind, "untrusted");
    await c.close();
  });

  test("switching the workspace asks about hand edits, then snapshots them and swaps the folders", async () => {
    const { c, project, events, threads } = await rig();
    c.handle({ type: "thread.new", name: "other" });
    await c.idle();
    await writeFile(join(project, "mine.txt"), "typed by hand\n");
    events.length = 0;
    c.handle({ type: "workspace.switch", thread: "other" });
    await c.idle();
    const ask = events.find((e) => e.type === "workspace.uncommitted");
    assert.ok(ask?.type === "workspace.uncommitted" && ask.thread === "other" && ask.from === "main" && ask.files.includes("mine.txt"));
    assert.equal(threads().find((t) => t.checkedOut)?.name ?? "main", "main", "nothing moved yet");

    c.handle({ type: "workspace.switch", thread: "other", uncommitted: "snapshot" });
    await c.idle();
    assert.equal(threads().find((t) => t.checkedOut)?.name, "other");
    const where = await (await Conversation.open(host, project)).git.currentBranch();
    assert.equal(where, "other");
    // The folders traded branches: the hand edit was saved on main, which now lives where `other` used to.
    assert.equal(await readFile(join(project, "mine.txt"), "utf8").catch(() => "gone"), "gone");
    assert.equal(await readFile(join(project, ".chattree", "threads", "other", "mine.txt"), "utf8"), "typed by hand\n");
    // The main thread is still the main thread.
    assert.equal(threads()[0]?.name, "main");
    assert.equal(threads()[0]?.kind, "main");
    await c.close();
  });

  test("opening a file goes to the editor: the thread's own file, an old version read-only, never outside the workspace", async () => {
    const { c, project, opened, notice, talk } = await rig();
    await writeFile(join(project, "a.txt"), "now\n");
    c.handle({ type: "file.open", thread: "main", path: "a.txt", line: 2 });
    await c.idle();
    assert.deepEqual(opened, [{ path: join(project, "a.txt"), line: 2, endLine: undefined }]);
    c.handle({ type: "file.open", thread: "main", path: "../outside.txt" });
    await c.idle();
    assert.match(notice(), /not inside/);
    c.handle({ type: "file.open", thread: "main", path: "nope.txt" });
    await c.idle();
    assert.match(notice(), /not in main's workspace/);
    const [first] = await talk("one");
    c.handle({ type: "file.open", thread: "main", path: "chat.yml", at: first!.commit });
    await c.idle();
    const old = opened.at(-1) as { content?: { label: string } };
    assert.match(old.content?.label ?? "", /chat\.yml @ /);
    await c.close();
  });
});
