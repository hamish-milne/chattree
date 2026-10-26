import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation, ConversationError, type NewEntry } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { verifyHistory } from "../../harness/verify.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const say = (t: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text: t }] });
const entries = async (c: Conversation): Promise<ChatEntry[]> => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
const texts = async (c: Conversation): Promise<string[]> => (await entries(c)).flatMap((e) => (e.$tag === "user" ? [e.content.map((p) => (p.$tag === "text" ? p.text : "")).join("")] : []));

async function fresh() {
  const dir = join(await tempDir(), "p");
  return { dir, convo: await Conversation.create(host, dir) };
}

describe("rewind", () => {
  test("goes back to an earlier commit: transcript and files as they were, the old tip kept under a ref, and the thread carries on", async () => {
    const { dir, convo } = await fresh();
    await writeFile(join(dir, "notes.txt"), "v1\n");
    const a = await convo.append(say("one"));
    await writeFile(join(dir, "notes.txt"), "v2\n");
    await convo.append(say("two"));
    await writeFile(join(dir, "scratch.txt"), "uncommitted at the time of the undo\n");
    const oldTip = await convo.git.head();

    const r = await convo.rewind(a.commit);
    assert.equal(r.to, a.commit);
    assert.equal(r.from === oldTip, false, "the uncommitted work was snapshotted first, so the old tip is that snapshot");
    assert.equal(await convo.git.head(), a.commit);
    assert.deepEqual(await texts(convo), ["one"]);
    assert.equal(await readFile(join(dir, "notes.txt"), "utf8"), "v1\n");
    await assert.rejects(readFile(join(dir, "scratch.txt"), "utf8"), "files added since are gone from the workspace");
    assert.equal(await convo.git.revParse(r.ref), r.from, "the ref keeps the old tip reachable");
    assert.match(r.ref, /^refs\/chattree\/undone\/main\//);

    // The old history is all there to recover.
    const recovered = await convo.git.text(["show", `${r.from}:scratch.txt`], { readOnly: true }).catch(() => undefined);
    assert.equal(recovered?.trim(), "uncommitted at the time of the undo");

    // The handle is consistent: it can append, and the index and the history check out.
    await convo.append(say("three"));
    assert.deepEqual(await texts(convo), ["one", "three"]);
    assert.equal((await convo.index()).filter((e) => e.tag === "user").length, 2);
    assert.deepEqual((await verifyHistory(convo)).filter((p) => p.severity === "error"), []);
    const reopened = await Conversation.open(host, dir);
    assert.deepEqual(await texts(reopened), ["one", "three"]);
  });

  test("refuses to go before the header, to a commit that is not earlier, or to where it already is", async () => {
    const { convo } = await fresh();
    const a = await convo.append(say("one"));
    const b = await convo.append(say("two"));
    await assert.rejects(convo.rewind(b.commit), /already is/);
    await assert.rejects(convo.rewind(`${a.commit}~5`), /is not a commit/);
    await convo.rewind(a.commit);
    await assert.rejects(convo.rewind(b.commit), /not an earlier commit/);
    // The header's own commit is a fine place to go back to: the thread is empty again.
    const first = (await convo.git.log("HEAD", { maxCount: 50 })).at(-1);
    assert.ok(first);
    await convo.rewind(first.hash);
    assert.deepEqual(await texts(convo), []);
    await convo.append(say("fresh start"));
    assert.deepEqual(await texts(convo), ["fresh start"]);
  });

  test("in an adopted repository it will not go back into the user's own history", async () => {
    const dir = join(await tempDir(), "r");
    await host.fs.mkdir(dir);
    const g = async (...a: string[]) => host.exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
    await g("init", "-q", "--initial-branch=work");
    await writeFile(join(dir, "app.txt"), "code\n");
    await g("add", "-A");
    await g("commit", "-qm", "theirs");
    const theirs = new TextDecoder().decode((await g("rev-parse", "HEAD")).stdout).trim();
    const convo = await Conversation.adopt(host, dir);
    await convo.append(say("hi"));
    await assert.rejects(convo.rewind(theirs), /before the thread's header/);
  });
});
