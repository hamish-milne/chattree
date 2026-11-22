import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation } from "../../harness/conversation.ts";
import {
  EXTERNAL_DEFAULTS,
  EXTERNAL_KEY,
  numberedDiff,
  recordTouches,
  syncExternalFiles,
  trackedFiles,
  type ExternalSettings,
} from "../../harness/external-changes.ts";
import { versionOf } from "../../harness/starter/version.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const enc = new TextEncoder();
const str = (t: string | { $tag: "blob" }): string => (typeof t === "string" ? t : "<blob>");
const lines = (n: number, tag = "line"): string => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

async function fresh() {
  const dir = join(await tempDir(), "conv");
  const convo = await Conversation.create(host, dir, {});
  return { dir, convo };
}
const entries = async (c: Conversation) => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
/** The file as a tool would have shown it: written, then reported as touched. */
async function seen(c: Conversation, dir: string, path: string, text: string) {
  await writeFile(join(dir, path), text);
  await recordTouches(c, [{ path, version: await versionOf(enc.encode(text)) }]);
}
const notes = async (c: Conversation) => (await entries(c)).filter((e) => e.$tag === "injection" && e.key === EXTERNAL_KEY);

describe("numberedDiff", () => {
  test("numbers the new file's lines, leaves removed lines without a number, and marks gaps between hunks", () => {
    const unified = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -2,3 +2,3 @@",
      " two",
      "-three",
      "+THREE",
      " four",
      "@@ -20,2 +20,3 @@",
      " twenty",
      "+inserted",
      " twenty-one",
    ].join("\n");
    assert.equal(
      numberedDiff(unified),
      ["2\t two", "\t-three", "3\t+THREE", "4\t four", "...", "20\t twenty", "21\t+inserted", "22\t twenty-one"].join("\n"),
    );
  });
});

describe("what the model has seen", () => {
  test("a touch records the version and blob only while the file is still as the tool reported it", async () => {
    const { dir, convo } = await fresh();
    await writeFile(join(dir, "a.txt"), "one\n");
    const v = await versionOf(enc.encode("one\n"));
    await recordTouches(convo, [{ path: "a.txt", version: v }]);
    await recordTouches(convo, [{ path: "a.txt", version: "00000000" }]); // not what is on disk: nothing recorded
    await recordTouches(convo, [{ path: "../outside.txt", version: v }]);
    const { tracked } = trackedFiles(await entries(convo));
    assert.deepEqual([...tracked.keys()], ["a.txt"]);
    assert.equal(tracked.get("a.txt")?.version, v);
  });
});

describe("syncExternalFiles", () => {
  test("a change made by someone else is told as a numbered diff, and the new version is then the one tracked", async () => {
    const { dir, convo } = await fresh();
    await seen(convo, dir, "a.txt", lines(30));
    assert.equal(await syncExternalFiles(convo, EXTERNAL_DEFAULTS, undefined), false, "nothing changed");
    await writeFile(join(dir, "a.txt"), lines(30).replace("line 12\n", "CHANGED\n"));
    assert.equal(await syncExternalFiles(convo, EXTERNAL_DEFAULTS, undefined), true);
    const [note] = await notes(convo);
    assert.ok(note?.$tag === "injection");
    assert.match(str(note.text), /=== a\.txt: version [0-9a-f]{8} -> [0-9a-f]{8} ===/);
    assert.match(str(note.text), /\n\t-line 12\n12\t\+CHANGED\n/);
    assert.match(str(note.text), /not instructions/);
    const v = await versionOf(await host.fs.read(join(dir, "a.txt")));
    assert.equal(trackedFiles(await entries(convo)).tracked.get("a.txt")?.version, v);
    assert.equal(await syncExternalFiles(convo, EXTERNAL_DEFAULTS, undefined), false, "told once");
  });

  test("the person's uncommitted change is committed before the note, and a commit of their own changes nothing", async () => {
    const { dir, convo } = await fresh();
    await seen(convo, dir, "a.txt", "one\ntwo\n");
    await writeFile(join(dir, "a.txt"), "one\n2\n");
    await convo.git.addAll();
    await convo.git.commit({
      message: "the person's own commit",
      author: { name: "t", email: "t@t" },
      committer: { name: "t", email: "t@t" },
    });
    await writeFile(join(dir, "a.txt"), "one\n2\nthree\n");
    assert.equal(await syncExternalFiles(convo, EXTERNAL_DEFAULTS, undefined), true);
    const [note] = await notes(convo);
    assert.ok(note?.$tag === "injection");
    assert.match(str(note.text), /\t-two\n2\t\+2\n3\t\+three/);
    assert.equal(await convo.git.isClean(), true, "the worktree was snapshotted");
  });

  test("a deleted file, a binary file and one seen too long ago are marked no longer valid, without the new version", async () => {
    const { dir, convo } = await fresh();
    await seen(convo, dir, "gone.txt", "x\n");
    await seen(convo, dir, "bin.dat", "text\n");
    await rm(join(dir, "gone.txt"));
    await writeFile(join(dir, "bin.dat"), new Uint8Array([1, 0, 2, 3]));
    assert.equal(await syncExternalFiles(convo, EXTERNAL_DEFAULTS, undefined), true);
    const [note] = await notes(convo);
    assert.ok(note?.$tag === "injection");
    assert.match(str(note.text), /=== gone\.txt: deleted/);
    assert.match(str(note.text), /=== bin\.dat: changed outside this conversation and is not text; its version is no longer valid/);
    assert.equal(trackedFiles(await entries(convo)).tracked.size, 0);

    await seen(convo, dir, "old.txt", "a\n");
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "x".repeat(3000) }] });
    await writeFile(join(dir, "old.txt"), "b\n");
    const tiny: ExternalSettings = { ...EXTERNAL_DEFAULTS, windowShare: 0.001 };
    assert.equal(await syncExternalFiles(convo, tiny, 1000), true);
    const last = (await notes(convo)).at(-1);
    assert.ok(last?.$tag === "injection");
    assert.match(str(last.text), /=== old\.txt: changed outside this conversation since you last read it; its version is no longer valid/);
  });

  test("a diff past the limit is only marked stale, and the feature can be turned off", async () => {
    const { dir, convo } = await fresh();
    await seen(convo, dir, "big.txt", lines(200));
    await writeFile(join(dir, "big.txt"), lines(200, "other"));
    assert.equal(await syncExternalFiles(convo, { ...EXTERNAL_DEFAULTS, enabled: false }, undefined), false);
    assert.equal(await syncExternalFiles(convo, { ...EXTERNAL_DEFAULTS, maxDiffBytes: 300 }, undefined), true);
    const [note] = await notes(convo);
    assert.ok(note?.$tag === "injection");
    assert.match(str(note.text), /by more than can be shown; its version is no longer valid/);
    assert.doesNotMatch(str(note.text), /other 5/);
  });

  test("a compaction after the file was seen ends its relevance", async () => {
    const { dir, convo } = await fresh();
    await seen(convo, dir, "a.txt", "one\n");
    // a compaction entry that replaces nothing important: only its position matters
    const u = await convo.append({ $tag: "user", content: [{ $tag: "text", text: "hello" }] });
    await convo.append({ $tag: "compaction", replaces: { from: u.id, to: u.id }, summary: "s" });
    await writeFile(join(dir, "a.txt"), "two\n");
    assert.equal(await syncExternalFiles(convo, EXTERNAL_DEFAULTS, undefined), true);
    const [note] = await notes(convo);
    assert.ok(note?.$tag === "injection");
    assert.match(str(note.text), /since you last read it; its version is no longer valid/);
  });
});
