import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { editorFor, loadSettings, settingsPath } from "../../cli/settings.ts";
import { busyboxFor } from "../../cli/toolset.ts";
import { FakeServer } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, host, initArgs, testIo } from "./support.ts";

const windows = { ...host, platform: "windows" as const };

describe("where the settings file is", () => {
  test("CHATTREE_SETTINGS first, then APPDATA on Windows, then XDG_CONFIG_HOME, then ~/.config", () => {
    assert.equal(settingsPath(host, { CHATTREE_SETTINGS: "/x/s.yml", HOME: "/h" }), host.path.resolve("/x/s.yml"));
    assert.equal(settingsPath(windows, { APPDATA: "C:\\Users\\a\\AppData\\Roaming", HOME: "/h" }), windows.path.join("C:\\Users\\a\\AppData\\Roaming", "chattree", "settings.yml"));
    assert.equal(settingsPath(host, { XDG_CONFIG_HOME: "/xdg", HOME: "/h" }), host.path.join("/xdg", "chattree", "settings.yml"));
    assert.equal(settingsPath(host, { HOME: "/h" }), host.path.join("/h", ".config", "chattree", "settings.yml"));
    assert.equal(settingsPath(host, {}), undefined);
  });

  test("no file means no settings", async () => {
    assert.deepEqual(await loadSettings({ host, env: { CHATTREE_SETTINGS: join(await tempDir(), "none.yml") } }), {});
    assert.deepEqual(await loadSettings({ host, env: {} }), {});
  });
});

describe("using the settings", () => {
  test("the editor is the setting, then $VISUAL, then $EDITOR", () => {
    assert.equal(editorFor({ env: { VISUAL: "v", EDITOR: "e" }, settings: { editor: "s" } }), "s");
    assert.equal(editorFor({ env: { VISUAL: "v", EDITOR: "e" } }), "v");
    assert.equal(editorFor({ env: { EDITOR: "e" } }), "e");
    assert.equal(editorFor({ env: {} }), undefined);
  });

  test("a busybox path that is not a file is an error naming the setting; off finds none", async () => {
    const io = testIo(await tempDir(), { host: windows, settings: { busybox: "/no/such/busybox.exe" } });
    await assert.rejects(() => busyboxFor(io), /busybox is \/no\/such\/busybox\.exe, which is not a file/);
    assert.equal(await busyboxFor(testIo(await tempDir(), { settings: { busybox: "/no/such" } })), undefined, "not Windows: no busybox");
  });
});

describe("the settings file in the CLI", () => {
  async function started() {
    const server = await FakeServer.start([answer("hi")]);
    const base = await tempDir();
    const dir = join(base, "p");
    assert.equal(await main(initArgs(server, dir), testIo(dir)), 0);
    return { server, dir, file: join(base, "settings.yml") };
  }

  test("display defaults apply to a new session, /settings shows the file, and /display still overrides", async () => {
    const { server, dir, file } = await started();
    try {
      await writeFile(file, "display:\n  thinking: on\n  tools: full\n");
      const env = { CHATTREE_ENVIRONMENT: "off", CHATTREE_SETTINGS: file };
      const io = testIo(dir, { env, stdin: "/display\n/settings\n/display thinking off\n/display\n" });
      assert.equal(await main(["chat", "--plain"], io), 0);
      assert.match(io.stdout, /thinking: on\ntools: full/);
      assert.ok(io.stdout.includes(file), "the path is shown");
      assert.match(io.stdout, /thinking: off\ntools: full/);
    } finally {
      await server.close();
    }
  });

  test("a file that does not parse stops the command with its path and the problem; `chattree settings` shows the same", async () => {
    const { server, dir, file } = await started();
    try {
      for (const bad of ["edtor: vim\n", "display:\n  thinking: loud\n", "editor: [1\n"]) {
        await writeFile(file, bad);
        const env = { CHATTREE_ENVIRONMENT: "off", CHATTREE_SETTINGS: file };
        const io = testIo(dir, { env });
        assert.equal(await main(["status"], io), 1);
        assert.ok(io.stderr.includes(file), `${bad}: names the file`);
        assert.match(io.stderr, /chattree settings edit/);
        const shown = testIo(dir, { env });
        assert.equal(await main(["settings"], shown), 1);
        assert.ok(shown.stderr.includes(file));
      }
    } finally {
      await server.close();
    }
  });

  test("`chattree settings` with no file says where it would be and that nothing is set", async () => {
    const { server, dir, file } = await started();
    try {
      const io = testIo(dir, { env: { CHATTREE_ENVIRONMENT: "off", CHATTREE_SETTINGS: file } });
      assert.equal(await main(["settings"], io), 0);
      assert.ok(io.stdout.includes(file));
      assert.match(io.stdout, /nothing set/);
    } finally {
      await server.close();
    }
  });
});
