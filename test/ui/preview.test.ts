import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The preview bundle is what the views become in a webview, so it must build and must stay small and free of
 * Node-only code: a view that imported the harness would bring typebox, git and the file system into the page.
 */
test("the browser preview builds, and the views pull in nothing that cannot run in a webview", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-"));
  try {
    const run = spawnSync(process.execPath, ["--no-warnings", "extensions/vscode/tools/build-preview.mts"], {
      env: { ...process.env, PREVIEW_OUT: dir },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    for (const f of ["index.html", "preview.js", "preview.css"]) assert.ok((await stat(join(dir, f))).size > 0, f);
    const js = await readFile(join(dir, "preview.js"), "utf8");
    assert.ok(!/from ["']node:|require\(["']node:/.test(js), "a Node module is imported");
    assert.ok(!js.includes("typebox"), "the schemas (typebox) are not needed to draw");
    assert.equal(
      (js.match(/^\/\/ .*signals-core\.module\.js$/gm) ?? []).length,
      1,
      "one copy of the signals core, or signals stop reaching the views",
    );
    // The preview carries the mock and the harness's generated schema (about 65 kB); the extension's views get the schema from the controller.
    assert.ok(js.length < 480_000, `the bundle is ${js.length} bytes`);
    const css = await readFile(join(dir, "preview.css"), "utf8");
    assert.ok(css.includes("--vscode-scmGraph-foreground1") && css.includes("graph_graph"), "theme variables and the graph styles are in");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
