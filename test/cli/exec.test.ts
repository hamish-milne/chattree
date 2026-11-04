import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { Conversation } from "../../harness/conversation.ts";
import { FakeServer } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { host, initArgs, testIo } from "./support.ts";
import { approve } from "../support/trust.ts";

async function started() {
  const server = await FakeServer.start([]);
  const dir = join(await tempDir(), "p");
  const io = testIo(dir);
  assert.equal(await main(initArgs(server, dir), io), 0, io.stderr);
  return { server, dir };
}

describe("/exec", () => {
  test("runs the line through sh -c in the thread's worktree with the terminal handed over, shows a non-zero exit, and adds nothing to the transcript", async () => {
    const { server, dir } = await started();
    try {
      const calls: { stage: readonly string[]; cwd: string }[] = [];
      const codes = [0, 0, 3];
      const io = testIo(dir, { stdin: "/exec ls | wc -l\n/exec\n/exec false\n", exec: async (stage, cwd) => (calls.push({ stage, cwd }), codes[calls.length - 1] ?? 0) });
      io.host = { ...io.host, platform: "posix" as const }; // the Windows shell is the next test
      assert.equal(await main(["chat", "--plain", "-y"], io), 0, io.stderr);
      assert.deepEqual(calls.map((c) => c.stage), [["sh", "-c", "ls | wc -l"], ["sh", "-c", "exec sh"], ["sh", "-c", "false"]]);
      assert.ok(calls.every((c) => c.cwd === dir), "in the thread's worktree");
      assert.match(io.stderr, /exit 3/);
      assert.doesNotMatch(io.stderr, /exit 0/);
      const tags = (await (await Conversation.open(host, dir)).readEntries()).flatMap((e) => (e.ok ? [e.value.$tag] : []));
      assert.ok(!tags.includes("user"), "the model is not told");
    } finally {
      await server.close();
    }
  });

  test("on Windows the shell is busybox (the one the busybox setting names)", async () => {
    const { server, dir } = await started();
    try {
      const bb = join(await tempDir(), "busybox.exe");
      const fs = await import("node:fs/promises");
      await fs.writeFile(bb, "x");
      const settings = join(await tempDir(), "settings.yml");
      await fs.writeFile(settings, `busybox: ${JSON.stringify(bb)}\n`);
      const calls: (readonly string[])[] = [];
      const io = { ...testIo(dir, { env: { CHATTREE_ENVIRONMENT: "off", CHATTREE_SETTINGS: settings }, stdin: "/exec echo hi\n", exec: async (stage) => (calls.push(stage), 0) }) };
      io.host = { ...io.host, platform: "windows" as const };
      await main(["chat", "--plain", "-y"], io);
      assert.deepEqual(calls, [[bb, "sh", "-c", "echo hi"]]);
    } finally {
      await server.close();
    }
  });
});
