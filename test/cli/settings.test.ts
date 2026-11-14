import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main } from "../../cli/main.ts";
import { CliError } from "../../cli/io.ts";
import { FfmpegError } from "../../hosts/ffmpeg.ts";
import { editorFor, ensureFfmpegSetting, loadSettings, settingsPath } from "../../cli/settings.ts";
import { busyboxFor, resolveFfmpeg } from "../../cli/toolset.ts";
import { FakeServer } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { answer, host, initArgs, testIo } from "./support.ts";

const windows = { ...host, platform: "windows" as const };
/** Whatever machine runs the tests, this one behaves as a POSIX host (the real host on Windows would take APPDATA and a busybox). */
const posix = { ...host, platform: "posix" as const };

describe("where the settings file is", () => {
  test("CHATTREE_SETTINGS first, then APPDATA on Windows, then XDG_CONFIG_HOME, then ~/.config", () => {
    assert.equal(settingsPath(posix, { CHATTREE_SETTINGS: "/x/s.yml", HOME: "/h" }), posix.path.resolve("/x/s.yml"));
    assert.equal(settingsPath(windows, { APPDATA: "C:\\Users\\a\\AppData\\Roaming", HOME: "/h" }), windows.path.join("C:\\Users\\a\\AppData\\Roaming", "chattree", "settings.yml"));
    assert.equal(settingsPath(posix, { XDG_CONFIG_HOME: "/xdg", HOME: "/h" }), posix.path.join("/xdg", "chattree", "settings.yml"));
    assert.equal(settingsPath(posix, { HOME: "/h" }), posix.path.join("/h", ".config", "chattree", "settings.yml"));
    assert.equal(settingsPath(posix, {}), undefined);
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
    assert.equal(await busyboxFor(testIo(await tempDir(), { host: posix, settings: { busybox: "/no/such" } })), undefined, "not Windows: no busybox");
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

describe("the ffmpeg setting", () => {
  const settingsIo = async (text?: string) => {
    const path = join(await tempDir(), "settings.yml");
    if (text !== undefined) await writeFile(path, text);
    return { path, io: testIo(await tempDir(), { env: { CHATTREE_ENVIRONMENT: "off", CHATTREE_SETTINGS: path } }) };
  };

  test("it is false or a string; anything else (a bare key, a number) is an invalid settings file", async () => {
    for (const [text, ok] of [["ffmpeg: auto\n", true], ["ffmpeg: false\n", true], ["ffmpeg: /usr/bin/ffmpeg\n", true], ["ffmpeg:\n", false], ["ffmpeg: true\n", false], ["ffmpeg: 3\n", false]] as const) {
      const { io } = await settingsIo(text);
      if (ok) assert.deepEqual(Object.keys(await loadSettings(io)), ["ffmpeg"], text);
      else await assert.rejects(loadSettings(io), /is not valid/, text);
    }
  });

  test("ensureFfmpegSetting creates the file, adds the key to one without it keeping its comments, and leaves a key that is there alone", async () => {
    const fresh = await settingsIo();
    assert.deepEqual(await ensureFfmpegSetting(fresh.io), { path: fresh.path, changed: true });
    assert.equal((await loadSettings(fresh.io)).ffmpeg, "auto");

    const mine = await settingsIo("# my notes\neditor: code -w   # the one I like\n");
    assert.equal((await ensureFfmpegSetting(mine.io))?.changed, true);
    const text = await readFile(mine.path, "utf8");
    assert.match(text, /# my notes/);
    assert.match(text, /editor: code -w\s+# the one I like/);
    assert.match(text, /ffmpeg: auto/);

    for (const keep of ["ffmpeg: false\n", "ffmpeg: /x/ffmpeg\n", "ffmpeg: auto\n"]) {
      const s = await settingsIo(keep);
      assert.deepEqual(await ensureFfmpegSetting(s.io), { path: s.path, changed: false });
      assert.equal(await readFile(s.path, "utf8"), keep);
    }
  });

  test("a settings file that does not parse is left alone, and no location means nothing to do", async () => {
    const bad = await settingsIo("editor: [unclosed\n");
    assert.equal(await ensureFfmpegSetting(bad.io), undefined);
    assert.equal(await readFile(bad.path, "utf8"), "editor: [unclosed\n");
    assert.equal(await ensureFfmpegSetting({ host, env: {} }), undefined);
  });

  test("init adds it, with a note", async () => {
    const server = await FakeServer.start([answer("hi")]);
    try {
      const { path, io } = await settingsIo();
      const dir = join(await tempDir(), "p");
      assert.equal(await main(initArgs(server, dir), io), 0, io.stderr);
      assert.equal((await loadSettings(io)).ffmpeg, "auto");
      assert.match(io.stderr, /set `ffmpeg: auto` in .*settings\.yml/);
      assert.ok(path.length > 0);
    } finally {
      await server.close();
    }
  });

  test("unset is a hard error naming the fix, false converts nothing, a path must be a file, auto asks for an ffmpeg without flite", async () => {
    const io = testIo(await tempDir());
    await assert.rejects(resolveFfmpeg(io, undefined), (e: unknown) => e instanceof CliError && /ffmpeg setting is not set/.test(e.message) && /ffmpeg: auto/.test(e.hint ?? ""));
    assert.equal(await resolveFfmpeg(io, false), undefined);
    await assert.rejects(resolveFfmpeg(io, "/no/such/ffmpeg"), /which is not a file/);
    const exe = join(await tempDir(), "ffmpeg");
    await writeFile(exe, "x");
    assert.equal(await resolveFfmpeg(io, exe), exe);
    let asked: { flite?: boolean } | undefined;
    assert.equal(await resolveFfmpeg(io, "auto", async (o) => ((asked = o), "/found/ffmpeg")), "/found/ffmpeg");
    assert.equal(asked?.flite, false);
    await assert.rejects(resolveFfmpeg(io, "auto", async () => { throw new FfmpegError("ffmpeg was not found on the PATH", "install it"); }), (e: unknown) => e instanceof CliError && e.hint === "install it");
  });
});
