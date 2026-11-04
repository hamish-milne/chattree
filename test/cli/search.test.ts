import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { FakeServer } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, initArgs, testIo } from "./support.ts";

describe("/search", () => {
  test("finds words in the thread, leaves out what the model sees unless --visible, and /show opens a hit by its reference", async () => {
    const server = await FakeServer.start([answer("the flamingo is pink")]);
    const dir = join(await tempDir(), "p");
    try {
      assert.equal(await main(initArgs(server, dir), testIo(dir)), 0);
      const io = testIo(dir, { stdin: "tell me about flamingo\n/search flamingo\n/search flamingo --visible\n/search flamingo --visible --limit 1\n/search fl.m --regex --visible\n/search x --scope everywhere\n/search\n/show main:ZZZZZZ\n" });
      await main(["chat", "--plain"], io);
      const out = `${io.stdout}${io.stderr}`;
      assert.match(out, /no matches in 1 thread \(what the model already sees is left out/);
      assert.match(out, /2 matches in 1 thread/);
      assert.match(out, /main:[0-9A-Z]{26} {2}#\d+ (user|assistant)/);
      assert.match(out, /the closest 1 shown/);
      assert.match(out, /--scope takes thread, family or project, not everywhere/);
      assert.match(out, /give something to search for/);
      assert.match(out, /no thread main has no entry|thread main has no entry/);
    } finally {
      await server.close();
    }
  });
});
