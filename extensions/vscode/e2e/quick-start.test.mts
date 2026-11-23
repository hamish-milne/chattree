import { existsSync } from "node:fs";
import { join } from "node:path";
import { browser, expect, $ } from "@wdio/globals";
import { attachSetting } from "./attach-setting.mts";

const repo = (): string => join(process.env["CHATTREE_E2E_SCRATCH"] ?? "", "work", "code-repo");

describe("quick start in a git repository that has no conversation", () => {
  it("offers to start one, and starts it outside the repository", async () => {
    const workbench = await browser.getWorkbench();
    const bar = await workbench.getActivityBar();
    await (await bar.getViewControl("chattree"))?.openView();
    const [threads] = await workbench.getAllWebviews();
    await threads?.open();

    await expect($("body")).toHaveText(expect.stringContaining("Initialize in code-repo"));
    await $("button*=Initialize in code-repo").click();
    // It asks first, and says nothing is added to the repository.
    await expect($("body")).toHaveText(expect.stringContaining("stay as they are"));
    await $("button=Start conversation").click();
    // The trunk of the new conversation is drawn.
    await browser.waitUntil(async () => !(await $("body").getText()).includes("No conversation yet"), {
      timeout: 30_000,
      timeoutMsg: "the graph never showed the conversation",
    });
    await expect($("body")).toHaveText(expect.stringContaining("main"));
    await threads?.close();

    // The link was written beside the code, as the setting the editor reads back.
    const file = join(repo(), ".vscode", "settings.json");
    await browser.waitUntil(async () => existsSync(file), { timeout: 15_000, timeoutMsg: `${file} was not written` });
    const attach = attachSetting(file);
    expect(Object.keys(attach)).toEqual(["."]);
    expect(attach["."]).toContain(join(process.env["CHATTREE_E2E_SCRATCH"] ?? "", "data", "conversations"));
    // The repository itself is as it was: no conversation files in it.
    expect(existsSync(join(repo(), "chat.yml"))).toBe(false);
    expect(existsSync(join(repo(), "harness.yml"))).toBe(false);
  });
});
