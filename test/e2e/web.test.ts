import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { MockController } from "../../ui/fixtures/mock-controller.ts";
import { startWebHost } from "../../ui/host/web-host.ts";
import { slowOptions } from "../support/slow.ts";
import { playwrightDriver } from "./playwright-driver.ts";
import { journey } from "./journey.ts";
import { diskWorld } from "./world.ts";

/**
 * The whole product in a real browser, driven as a person would: the views over the web host, with the controller behind
 * it. Until the real controller exists the mock stands in, and the journey fails where the mock only pretends (it never
 * touches the disk). This is the success state the real controller is built towards (see docs/map/e2e.md); the `todo` is
 * lifted when it passes.
 */
test(
  "[slow] the journey: an empty folder to delivered files, in a browser",
  { ...slowOptions, todo: "the real controller is not written yet: the mock controller does not touch the disk", timeout: 120_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "chattree-e2e-"));
    const shots = process.env["E2E_SHOTS"];
    try {
      const web = join(dir, "web");
      const built = spawnSync(process.execPath, ["--no-warnings", "extensions/vscode/tools/build-web.mts"], {
        env: { ...process.env, WEB_OUT: web },
        encoding: "utf8",
      });
      assert.equal(built.status, 0, built.stderr);
      const root = join(dir, "workspace");
      await mkdir(join(root, "scratch"), { recursive: true });
      await writeFile(join(root, "scratch", "README.md"), "# scratch\n");

      const host = await startWebHost({ dir: web, controller: (emit) => new MockController({ emit, sleep: async () => {} }) });
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        if (process.env["E2E_TRACE"] !== undefined) page.on("console", (m) => console.log(`[page] ${m.text()}`));
        await page.goto(host.url);
        const driver = playwrightDriver(page, async (name, png) => {
          if (shots === undefined) return;
          await mkdir(shots, { recursive: true });
          await writeFile(join(shots, `${name}.png`), png);
        });
        const world = diskWorld(root, host, {
          folder: "scratch",
          tasks: { first: "Write notes.md with a first line", second: "Add a second line to notes.md" },
          deliverable: { path: "notes.md", afterFirst: "first line\n", afterSecond: "first line\nsecond line\n" },
        });
        try {
          await journey(driver, world);
        } catch (e) {
          if (shots !== undefined) await driver.screenshot("failed");
          throw e;
        }
      } finally {
        await browser.close();
        await host.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
