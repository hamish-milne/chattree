import { browser, expect } from "@wdio/globals";

describe("chattree in VS Code", () => {
  it("shows the thread graph in the side bar", async () => {
    const workbench = await browser.getWorkbench();
    const bar = await workbench.getActivityBar();
    const control = await bar.getViewControl("chattree");
    await control?.openView();

    const [threads] = await workbench.getAllWebviews();
    expect(threads).toBeDefined();
    await threads?.open();
    // The trunk of the conversation `init` made.
    await expect($("body")).toHaveText(expect.stringContaining("main"));
    await threads?.close();
  });

  it("shows the chat in the panel, asking for a provider", async () => {
    const workbench = await browser.getWorkbench();
    await workbench.executeCommand("chattree: Show chat");
    const webviews = await workbench.getAllWebviews();
    const chat = webviews.at(-1);
    expect(chat).toBeDefined();
    await chat?.open();
    await expect($("body")).toHaveText(expect.stringContaining("No provider yet"));
    await chat?.close();
  });
});
