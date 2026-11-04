import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { Conversation } from "../../harness/conversation.ts";
import { FakeServer } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, host, initArgs, testIo } from "./support.ts";

async function started(replies = [answer("hello there")]) {
  const server = await FakeServer.start(replies);
  const dir = join(await tempDir(), "p");
  assert.equal(await main(initArgs(server, dir), testIo(dir)), 0);
  return { server, dir };
}
const handEdit = async (dir: string) => writeFile(join(dir, "harness.yml"), (await readFile(join(dir, "harness.yml"), "utf8")).replace("max_turn_usd: 5", "max_turn_usd: 500"));

describe("approving harness.yml", () => {
  test("a file changed outside chattree is not used: the session says so, nothing is sent, and /trust shows the edit and approves it", async () => {
    const { server, dir } = await started();
    try {
      await handEdit(dir);
      const refused = testIo(dir, { stdin: "hello\n" });
      assert.equal(await main(["chat", "--plain"], refused), 1, "a message that could not be sent is a failure");
      assert.match(refused.stderr, /harness\.yml has changed since you approved it for thread main/);
      assert.match(refused.stderr, /changed outside chattree since you approved it/);
      assert.equal(server.seen.length, 0, "nothing was sent");

      // Nobody to ask (a script): not approved.
      const no = testIo(dir, { stdin: "/trust\n" });
      await main(["chat", "--plain"], no);
      assert.match(`${no.stdout}${no.stderr}`, /\+ {2}max_turn_usd: 500/, "the edit is shown");
      assert.match(`${no.stdout}${no.stderr}`, /not approved/);
      assert.equal((await (await Conversation.open(host, dir)).configTrust()).state, "changed");

      // Approved: the thread is reopened with its providers and the message goes.
      const yes = testIo(dir, { stdin: "/trust\nhello\n" });
      await main(["chat", "--plain", "-y"], yes);
      assert.match(`${yes.stdout}${yes.stderr}`, /approved harness\.yml for thread main/);
      assert.match(yes.stdout, /hello there/);
      assert.equal(server.seen.length, 1);
    } finally {
      await server.close();
    }
  });

  test("a verb that needs the model refuses with a pointer, and `chattree trust` reports an approved file as such", async () => {
    const { server, dir } = await started();
    try {
      const ok = testIo(dir);
      assert.equal(await main(["trust"], ok), 0);
      assert.match(ok.stdout + ok.stderr, /is the file you approved for thread main/);
      await handEdit(dir);
      const say = testIo(dir);
      assert.equal(await main(["say", "hi"], say), 1);
      assert.match(say.stderr, /changed outside chattree[\s\S]*chattree trust/);
      assert.equal(server.seen.length, 0);
    } finally {
      await server.close();
    }
  });
});
