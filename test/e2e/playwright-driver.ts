import type { Locator, Page } from "playwright";
import type { Driver, Target } from "./driver.ts";

const DEFAULT_WAIT = 15_000;

/** A `Driver` that uses a Playwright page. */
export function playwrightDriver(page: Page, shots?: (name: string, png: Buffer) => Promise<void> | void): Driver {
  const find = (t: Target): Locator => {
    if ("role" in t) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the role is whatever the journey wrote; Playwright rejects an unknown one when it runs
      const role = t.role as Parameters<Page["getByRole"]>[0];
      return page
        .getByRole(role, {
          ...(t.name === undefined ? {} : { name: t.name }),
          ...(t.expanded === undefined ? {} : { expanded: t.expanded }),
          ...(t.disabled === undefined ? {} : { disabled: t.disabled }),
        })
        .first();
    }
    if ("label" in t) return page.getByLabel(t.label).first();
    return page.getByText(t.text).first();
  };
  const show = (t: Target): string => JSON.stringify(t, (_, v: unknown) => (v instanceof RegExp ? v.toString() : v));
  const wrap = async <T>(what: string, t: Target, f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      throw new Error(`${what} ${show(t)}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`, { cause: e });
    }
  };
  return {
    click: (t) => wrap("click", t, () => find(t).click({ timeout: DEFAULT_WAIT })),
    rightClick: (t) => wrap("right-click", t, () => find(t).click({ button: "right", timeout: DEFAULT_WAIT })),
    type: (t, text) => wrap("type into", t, () => find(t).fill(text, { timeout: DEFAULT_WAIT })),
    expectVisible: (t, ms = DEFAULT_WAIT) => wrap("expect visible", t, () => find(t).waitFor({ state: "visible", timeout: ms })),
    expectGone: (t, ms = DEFAULT_WAIT) => wrap("expect gone", t, () => find(t).waitFor({ state: "hidden", timeout: ms })),
    text: (t) => wrap("read", t, async () => (await find(t).textContent({ timeout: DEFAULT_WAIT }))?.trim() ?? ""),
    screenshot: async (name) => {
      await shots?.(name, await page.screenshot());
    },
  };
}
