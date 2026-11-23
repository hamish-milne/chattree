import { realpathSync } from "node:fs";
import { join } from "node:path";
import { browser, expect, $ } from "@wdio/globals";
import { attachSetting } from "./attach-setting.mts";

describe("the repository, moved and renamed since its quick start", () => {
  it("finds its conversation through the setting that moved with it, and links the code again", async () => {
    const scratch = process.env["CHATTREE_E2E_SCRATCH"] ?? "";
    const moved = join(scratch, "moved", "renamed-repo");
    const workbench = await browser.getWorkbench();
    const bar = await workbench.getActivityBar();
    await (await bar.getViewControl("chattree"))?.openView();
    const [threads] = await workbench.getAllWebviews();
    await threads?.open();
    await browser.waitUntil(async () => (await $("body").getText()).includes("main"), {
      timeout: 30_000,
      timeoutMsg: "the conversation was not found",
    });
    await expect($("body")).not.toHaveText(expect.stringContaining("Initialize in"));
    await threads?.close();

    // The conversation's link to the code now points at the new place.
    const project = attachSetting(join(moved, ".vscode", "settings.json"))["."] ?? "";
    await browser.waitUntil(
      async () => {
        try {
          return realpathSync(join(project, "code")) === realpathSync(moved);
        } catch {
          return false;
        }
      },
      { timeout: 15_000, timeoutMsg: "the link was not made again at the new path" },
    );
  });
});
