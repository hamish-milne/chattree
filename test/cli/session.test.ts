import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Engine } from "../../cli/engine.ts";
import { CliError } from "../../cli/io.ts";
import { main } from "../../cli/main.ts";
import { findProject, openThread } from "../../cli/project.ts";
import { SessionStore } from "../../cli/session.ts";
import { acquireLock } from "../../src/index.ts";
import { FakeServer } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, host, initArgs, testIo } from "./support.ts";

async function setup(opts: { now?: () => number; stale?: number } = {}) {
  const server = await FakeServer.start([answer("hi")]);
  const dir = join(await tempDir(), "p");
  const io = testIo(dir, opts.now === undefined ? {} : { now: opts.now });
  assert.equal(await main(initArgs(server, dir), io), 0, io.stderr);
  const project = await findProject(io, dir);
  const store = await SessionStore.open(io, project.git, { debounceMs: 5, heartbeatMs: 0, ...(opts.stale === undefined ? {} : { staleAfterMs: opts.stale }) });
  return { server, dir, io, project, store };
}

const staged = (n: string) => ({ path: `/tmp/${n}`, name: n, mime: "text/plain", charset: "utf-8", size: 3, mtimeMs: 1234.5 });

describe("session store", () => {
  test("pending state survives close and resume exactly; the file is canonical YAML", async () => {
    const { server, store } = await setup();
    try {
      const a = await store.create("main");
      a.state.draft = "line one\n\nline “two” \u0007 with\ttab\n";
      a.state.history.push("first", "multi\nline");
      a.state.thinking = "brief";
      a.state.attachments.push(staged("a.txt"), { ...staged("b.png"), mime: "image/png" });
      await a.close();
      const text = await readFile(join(store.dir, `${a.id}.yml`), "utf8");
      assert.match(text, /^- !session\n/);
      const { session: b, resumed } = await store.open({ thread: "main" });
      assert.equal(resumed, true);
      assert.equal(b.id, a.id);
      assert.deepEqual(b.state, a.state);
      assert.equal(b.created, a.created);
      await b.close();
    } finally {
      await server.close();
    }
  });

  test("a session with nothing pending leaves no file; history and preferences alone do not keep it", async () => {
    const { server, store } = await setup();
    try {
      const a = await store.create("main");
      a.state.history.push("hello");
      a.state.thinking = "on";
      a.touch();
      await a.flush();
      assert.equal((await store.ids()).length, 1, "written while running, so a crash keeps it");
      await a.close();
      assert.deepEqual(await store.ids(), []);
    } finally {
      await server.close();
    }
  });

  test("resume takes the earliest unlocked session for the thread; locked and other threads are left alone; fresh starts another", async () => {
    const { server, store } = await setup();
    try {
      const mk = async (thread: string, draft: string) => {
        const s = await store.create(thread);
        s.state.draft = draft;
        await s.close();
        return s.id;
      };
      const first = await mk("main", "one");
      const other = await mk("side", "two");
      const third = await mk("main", "three");
      const held = await store.open({ thread: "main" });
      assert.equal(held.session.id, first);
      const next = await store.open({ thread: "main" });
      assert.equal(next.session.id, third, "the first is in use, so the next earliest");
      const none = await store.open({ thread: "main" });
      assert.equal(none.resumed, false);
      assert.notEqual(none.session.id, first);
      assert.equal((await store.open({ thread: "side" })).session.id, other);
      const fresh = await store.open({ thread: "main", fresh: true });
      assert.equal(fresh.resumed, false);
      const info = await store.list();
      assert.deepEqual(info.map((i) => [i.id, i.thread, i.locked]).slice(0, 3), [[first, "main", true], [other, "side", true], [third, "main", true]]);
    } finally {
      await server.close();
    }
  });

  test("by id or unique prefix; the session's own thread wins; unknown, ambiguous and locked ids are refused", async () => {
    const { server, store } = await setup();
    try {
      const a = await store.create("side");
      a.state.draft = "x";
      await a.close();
      const b = await store.create("main");
      b.state.draft = "y";
      await b.close();
      const open = await store.open({ thread: "main", id: a.id.slice(0, 20) });
      assert.equal(open.session.thread, "side");
      await assert.rejects(store.open({ thread: "main", id: a.id }), (e) => e instanceof CliError && /in use/.test(e.message));
      await assert.rejects(store.open({ thread: "main", id: "ZZZ" }), /there is no session ZZZ/);
      await assert.rejects(store.open({ thread: "main", id: "01" }), /matches 2 sessions/);
    } finally {
      await server.close();
    }
  });

  test("an unreadable session is skipped with the reason, listed with its error, and left in place", async () => {
    const { server, store } = await setup();
    try {
      const a = await store.create("main");
      a.state.draft = "kept";
      await a.close();
      const path = join(store.dir, `${a.id}.yml`);
      const good = await readFile(path, "utf8");
      await writeFile(path, good.replace("format: 1", "format: 2"));
      const r = await store.open({ thread: "main" });
      assert.equal(r.resumed, false);
      assert.match(r.skipped[0] ?? "", new RegExp(`session ${a.id} was not used`));
      assert.match((await store.list()).find((i) => i.id === a.id)?.error ?? "", /format/);
      await writeFile(path, good.slice(0, -1)); // truncated: no completion marker
      assert.match((await store.list())[0]?.error ?? "", /blank line|incomplete/);
      assert.equal((await readFile(path, "utf8")).length, good.length - 1, "never deleted or rewritten");
      await assert.rejects(store.open({ thread: "main", id: a.id }), /cannot be read/);
    } finally {
      await server.close();
    }
  });

  test("a crashed session's lock goes stale and the session comes back with its draft", async () => {
    let now = 1_000_000;
    const { server, io, project } = await setup({ now: () => now });
    try {
      const store = await SessionStore.open(io, project.git, { heartbeatMs: 0, debounceMs: 5, staleAfterMs: 30_000 });
      const crashed = await store.create("main");
      crashed.state.draft = "typed before the crash";
      crashed.touch();
      await crashed.flush(); // and never closed
      assert.equal((await store.open({ thread: "main" })).resumed, false, "still held");
      now += 31_000;
      const back = await store.open({ thread: "main" });
      assert.equal(back.session.id, crashed.id);
      assert.equal(back.session.state.draft, "typed before the crash");
    } finally {
      await server.close();
    }
  });

  test("the heartbeat keeps a long session's lock fresh", async () => {
    const { server, io, project } = await setup();
    try {
      const store = await SessionStore.open(io, project.git, { heartbeatMs: 20, staleAfterMs: 100, debounceMs: 5 });
      const s = await store.create("main");
      s.state.draft = "x";
      s.touch();
      await new Promise((r) => setTimeout(r, 350));
      const other = await store.open({ thread: "main" });
      assert.equal(other.resumed, false, "refreshed, so not stale after 3.5 stale-periods");
      await other.session.close();
      assert.equal(s.lockLost, false);
      await s.close();
    } finally {
      await server.close();
    }
  });

  test("typing is written once after the delay, in order, and flush does not overlap writes", async () => {
    const { server, store } = await setup();
    try {
      const s = await store.create("main");
      for (let i = 0; i < 20; i++) {
        s.state.draft += "x";
        s.touch();
      }
      assert.deepEqual(await store.ids(), [], "not written yet");
      await new Promise((r) => setTimeout(r, 60));
      assert.match(await readFile(join(store.dir, `${s.id}.yml`), "utf8"), /x{20}/);
      s.state.draft += "y";
      s.touch();
      await Promise.all([s.flush(), s.flush(), s.flush()]);
      assert.match(await readFile(join(store.dir, `${s.id}.yml`), "utf8"), /x{20}y/);
      await s.close();
    } finally {
      await server.close();
    }
  });
});

describe("a session in the engine", () => {
  test("staging a file is saved after the command, /status and /sessions show it, and a later session finds it", async () => {
    const { server, io, project, store } = await setup();
    try {
      const file = join(project.root, "notes.txt");
      await writeFile(file, "remember\n");
      const { session } = await store.open({ thread: "main" });
      const opened = await openThread(io, project, undefined, { providers: "optional" });
      const engine = new Engine({ io, project, opened, session, sessions: store });
      const run = async (line: string) => {
        const out: string[] = [];
        for await (const o of engine.submit(line)) out.push(o.type === "text" ? o.text : JSON.stringify(o));
        return out.join("\n");
      };
      assert.equal(await run(`/attach ${file}`) !== "", true);
      await session.flush();
      assert.equal(session.state.attachments.length, 1);
      assert.match(await run("/status"), /staged:\s+1 file/);
      assert.match(await run("/sessions"), new RegExp(`\\* ${session.id}  main .*1 file.*this session`));
      await engine.session?.close();
      const again = await store.open({ thread: "main" });
      assert.equal(again.resumed, true);
      assert.equal(again.session.state.attachments[0]?.path, file);
      assert.equal(again.session.state.attachments[0]?.mime, "text/plain");
    } finally {
      await server.close();
    }
  });
});

describe("lock refresh", () => {
  test("stamps the lock, and does nothing once it was taken over", async () => {
    let now = 0;
    const path = join(await tempDir(), "x.lock");
    const a = await acquireLock(host.fs, path, { owner: "a", now: () => now, timeoutMs: 0, staleAfterMs: 1000 });
    now = 900;
    assert.equal(await a.refresh(), true);
    now = 1800; // would be stale without the refresh
    await assert.rejects(acquireLock(host.fs, path, { owner: "b", now: () => now, timeoutMs: 0, staleAfterMs: 1000 }), /locked by/);
    now = 5000;
    const b = await acquireLock(host.fs, path, { owner: "b", now: () => now, timeoutMs: 0, staleAfterMs: 1000 });
    assert.equal(await a.refresh(), false);
    assert.equal(await b.release(), true);
  });
});
