import assert from "node:assert/strict";
import { parseFile, scan } from "../../src/index.ts";
import { CHAT_FILE, type Conversation } from "../../harness/conversation.ts";
import { buildContext, contextProblems } from "../../harness/context-builder.ts";

/** The properties every conversation must have at every commit. */
export async function assertHistoryInvariants(convo: Conversation): Promise<void> {
  const git = convo.git;
  const tip = await git.readFileAt("HEAD", CHAT_FILE);
  assert.ok(tip !== undefined);
  scan(tip); // strictly framed
  parseFile(tip); // strictly canonical
  const commits = (await git.log("HEAD", { firstParent: true })).reverse();
  let prevLen = 0;
  for (const c of commits) {
    const at = await git.readFileAt(c.hash, CHAT_FILE);
    assert.ok(at !== undefined, `chat.yml missing at ${c.hash}`);
    assert.ok(at.length >= prevLen, "transcript never shrinks");
    assert.deepEqual(tip.subarray(0, at.length), at, `commit ${c.hash} is a byte prefix of the tip`);
    assert.equal(scan(at).truncated, false);
    const offset = c.trailers["Chattree-Offset"]?.[0];
    assert.equal(offset, String(at.length), `Chattree-Offset at ${c.hash}`);
    prevLen = at.length;
  }
}

/** A context can be built from the branch at `rev`, however it got there, and satisfies the structural rules providers enforce. */
export async function assertContextBuilds(convo: Conversation, rev?: string): Promise<void> {
  const entries = (rev === undefined ? await convo.readEntries() : await convo.readEntriesAt(rev)).flatMap((e) => (e.ok ? [e.value] : []));
  const dec = new TextDecoder();
  for (const target of [{ provider: "anthropic", model: "m" }, { provider: "openai", model: "other" }]) {
    const ctx = await buildContext(entries, {
      system: "s",
      target,
      readText: async (r) => {
        const bytes = await convo.store.get(r.sha256);
        assert.ok(bytes !== undefined, "blob present");
        return dec.decode(bytes);
      },
    });
    assert.deepEqual(contextProblems(ctx), [], `context for ${rev ?? "HEAD"} as ${target.provider}`);
  }
}
