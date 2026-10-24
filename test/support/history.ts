import assert from "node:assert/strict";
import { parseFile, scan } from "../../src/index.ts";
import { CHAT_FILE, type Conversation } from "../../harness/conversation.ts";

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
