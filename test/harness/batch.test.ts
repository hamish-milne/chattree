import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { harnessConfig } from "../../harness/config.ts";
import { batchProblem, batchStage, findProgram } from "../../harness/starter/batch.ts";
import { runTool } from "../../harness/starter/run.ts";
import type { Host, RunSpec } from "../../src/host.ts";
import { parseConfig } from "../../src/config.ts";
import { tempDir } from "../support/tmp.ts";

/** A host that says it is Windows and records what `run` is asked to start (paths are POSIX, which is enough for the lookup). */
function windowsHost() {
  const base = nodeHost();
  const specs: RunSpec[] = [];
  const host = { ...base, platform: "windows" as const, run: (spec: RunSpec) => (specs.push(spec), Promise.resolve({ exitCode: 0, stageCodes: [0], output: new TextEncoder().encode("ran"), dropped: 0, timedOut: false, aborted: false })) };
  return { host, specs };
}

async function setup(files: string[]) {
  const root = await tempDir();
  const workspace = join(root, "ws");
  const bin = join(root, "bin");
  const bin2 = join(root, "bin2");
  for (const d of [workspace, bin, bin2]) await mkdir(d, { recursive: true });
  for (const f of files) {
    await mkdir(join(root, f, ".."), { recursive: true });
    await writeFile(join(root, f), "");
  }
  return { root, workspace, bin, bin2 };
}

const call = async (host: Host, workspace: string, opts: Parameters<typeof runTool>[0], command: string) => {
  const tool = runTool(opts);
  return (await tool.execute({ command }, { signal: new AbortController().signal, callId: "c", workspace, host })) as { content: string; is_error?: boolean };
};

describe("batch programs on Windows", () => {
  test("by default a .cmd program is not started, and the message says what to set", async () => {
    const { workspace, bin } = await setup(["bin/pnpm.cmd"]);
    const { host, specs } = windowsHost();
    const r = await call(host, workspace, { hostEnv: { PATH: bin } }, "pnpm test");
    assert.equal(r.is_error, true);
    assert.match(r.content, /pnpm is a batch program.*tools\.run\.batch: true/);
    assert.equal(specs.length, 0);
  });

  test("with the flag it is started through cmd.exe with a verbatim command line", async () => {
    const { workspace, bin } = await setup(["bin/pnpm.cmd"]);
    const { host, specs } = windowsHost();
    const r = await call(host, workspace, { batch: true, hostEnv: { PATH: bin, ComSpec: "C:\\Windows\\System32\\cmd.exe" } }, "pnpm run 'two words' -r");
    assert.equal(r.is_error, false, r.content);
    assert.deepEqual(specs[0]!.stages[0], ["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", `""${join(bin, "pnpm.cmd")}" run "two words" -r"`]);
    assert.deepEqual(specs[0]!.verbatim, [true]);
  });

  test("an argument cmd.exe would interpret is refused, not escaped", async () => {
    const { workspace, bin } = await setup(["bin/npm.cmd"]);
    const { host, specs } = windowsHost();
    for (const bad of ["'a&calc'", "'%PATH%'", "'x|y'", "'a^b'", "'say \"hi\"'", "'a>b'", "'hi!'"]) {
      const r = await call(host, workspace, { batch: true, hostEnv: { PATH: bin } }, `npm run ${bad}`);
      assert.equal(r.is_error, true, bad);
      assert.match(r.content, /cmd\.exe would interpret/, bad);
    }
    assert.equal(specs.length, 0);
  });

  test("a program in the workspace is not found by name, and PATH entries inside it are skipped", async () => {
    const { workspace, bin } = await setup(["ws/git.cmd", "ws/tools/x.cmd"]);
    const { host } = windowsHost();
    const env = { PATH: `${workspace};relative\\dir;${join(workspace, "tools")};${bin}` };
    assert.equal(await findProgram(host, workspace, "git", env), undefined);
    assert.equal(await findProgram(host, workspace, "x", env), undefined);
  });

  test("an .exe earlier on PATH wins, and so does an .exe beside the .cmd", async () => {
    const { workspace, bin, bin2 } = await setup(["bin/tool.exe", "bin2/tool.cmd", "bin2/other.exe", "bin2/other.cmd"]);
    const { host } = windowsHost();
    assert.equal(await findProgram(host, workspace, "tool", { PATH: `${bin};${bin2}` }), join(bin, "tool.exe"));
    assert.equal(await findProgram(host, workspace, "other", { PATH: bin2 }), join(bin2, "other.exe"));
  });

  test("a batch file named with a path or extension must be inside the workspace", async () => {
    const { workspace, root } = await setup(["ws/build.cmd", "outside.cmd"]);
    const { host } = windowsHost();
    assert.equal(await findProgram(host, workspace, "build.cmd", {}), join(workspace, "build.cmd"));
    assert.equal(await findProgram(host, workspace, "./build", {}), join(workspace, "build.cmd"));
    assert.equal(await findProgram(host, workspace, "../outside.cmd", {}), undefined);
    assert.equal(await findProgram(host, workspace, join(root, "outside.cmd"), {}), undefined);
  });

  test("programs that are not batch files, and other platforms, are untouched", async () => {
    const { workspace, bin } = await setup(["bin/node.exe"]);
    const { host, specs } = windowsHost();
    await call(host, workspace, { batch: true, hostEnv: { PATH: bin } }, "node -v");
    assert.deepEqual(specs[0]!.stages[0], ["node", "-v"]);
    assert.equal(specs[0]!.verbatim, undefined);
    const posix = { ...host, platform: "posix" as const };
    const s2 = await setup(["bin/pnpm.cmd"]);
    await call(posix, s2.workspace, { batch: true, hostEnv: { PATH: s2.bin } }, "pnpm test");
    assert.deepEqual(specs[1]!.stages[0], ["pnpm", "test"]);
  });

  test("the helpers: stage text and argument checks", () => {
    assert.deepEqual(batchStage("cmd.exe", "C:\\p\\a b\\x.cmd", ["1", "two words", ""]), ["cmd.exe", "/d", "/s", "/c", '""C:\\p\\a b\\x.cmd" 1 "two words" """']);
    assert.equal(batchProblem("C:\\x.cmd", ["fine", "also fine"]), undefined);
    assert.match(batchProblem("C:\\x.cmd", ["a\nb"]) ?? "", /interpret/);
    assert.match(batchProblem("C:\\R&D\\x.cmd", []) ?? "", /path/);
    assert.match(batchProblem("C:\\x.cmd", ["a b\\"]) ?? "", /backslash/);
  });

  test("harness.yml accepts tools.run.batch and nothing else new", async () => {
    assert.ok((await parseConfig("providers: {}\ntools:\n  run:\n    batch: true\n", harnessConfig)).ok);
    assert.ok(!(await parseConfig("providers: {}\ntools:\n  run:\n    batch: yes please\n", harnessConfig)).ok);
  });
});
