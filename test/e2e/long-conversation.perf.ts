import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { startWebHost, type HostedController } from "../../ui/host/web-host.ts";
import type { UiEvent } from "../../ui/model/protocol.ts";
import { longConversation, type Long } from "./perf-data.ts";

/**
 * The views with a long conversation: thousands of commits in the graph and thousands of blocks in the transcript, behind the
 * web host with a controller that serves them from memory (so only the views are timed, not the harness). What a person feels:
 *   - a new item: from pressing Enter to the message and its commit being painted (budget 100 ms);
 *   - scrolling: the main-thread work of one frame of a scroll (budget 10 ms), for the transcript and for the graph.
 * Each is measured in the page, as the p95 of many runs (scrolling at a typical speed is held to the budget; a hard flick is reported). `CHATTREE_PERF_OUT` names a file to write the numbers to; `PERF_N`
 * sets the size (default 5000 of each). Run alone with `pnpm test:perf`: it times the views, so other work on the machine spoils it.
 */
const N = Number(process.env["PERF_N"] ?? 5000);
const ADD_BUDGET_MS = 100;
const SCROLL_BUDGET_MS = 10;
const WARM_UP_ADDS = 3;
/** Pixels scrolled per frame: a steady wheel or trackpad (about 6000 px/s), and a hard flick. Only the first is held to the budget. */
const TYPICAL_STEP_PX = 100;
const FAST_STEP_PX = 400;

function controllerOver(data: Long): (emit: (e: UiEvent) => void) => HostedController {
  return (emit) => ({
    handle(intent) {
      if (intent.type === "ready" && intent.view === "graph") {
        emit({ type: "graph.data", data: data.graph });
        emit({ type: "graph.selected", thread: "main" });
      } else if (intent.type === "ready" && intent.view === "chat") emit({ type: "chat.open", state: data.chat });
      else if (intent.type === "chat.send") {
        const made = data.next(intent.text);
        emit({ type: "chat.append", blocks: made.blocks });
        emit({ type: "graph.data", data: made.graph });
      }
    },
  });
}

interface Stats {
  n: number;
  p50: number;
  p95: number;
  max: number;
}
const stats = (xs: number[]): Stats => {
  const s = xs.toSorted((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s.at(-1) ?? 0 };
};
const round = (s: Stats): Stats => ({
  n: s.n,
  p50: Math.round(s.p50 * 10) / 10,
  p95: Math.round(s.p95 * 10) / 10,
  max: Math.round(s.max * 10) / 10,
});

/** Press Enter in the composer `times` times; the page notes when each message and its commit are painted. */
async function addItems(page: Page, times: number): Promise<{ chat: number[]; graph: number[] }> {
  await page.evaluate("window.__perfKit.watchAdds()");
  const box = page.getByRole("textbox", { name: "Message" });
  for (let i = 0; i < times; i++) {
    const marker = `perfmark${i}x`;
    await page.evaluate(`window.__marker = ${JSON.stringify(marker)}`);
    await box.fill(`${marker} one more message`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(`window.__perf[${i}]?.chat !== undefined && window.__perf[${i}]?.graph !== undefined`, undefined, {
      timeout: 20_000,
    });
  }
  const perf: { chat?: number; graph?: number }[] = await page.evaluate("window.__perf");
  return {
    chat: perf.flatMap((p) => (p.chat === undefined ? [] : [p.chat])),
    graph: perf.flatMap((p) => (p.graph === undefined ? [] : [p.graph])),
  };
}

const scrollCosts = (page: Page, target: "transcript" | "graph", steps: number, stepPx: number, from: "end" | "start"): Promise<number[]> =>
  page.evaluate(`window.__perfKit.scrollCosts(${JSON.stringify(target)}, ${steps}, ${stepPx}, ${JSON.stringify(from)})`);

test("long conversation: a new item paints in under 100 ms, a scroll frame costs under 10 ms", { timeout: 600_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "chattree-perf-"));
  try {
    const web = join(dir, "web");
    const built = spawnSync(process.execPath, ["--no-warnings", "extensions/vscode/tools/build-web.mts"], {
      env: { ...process.env, WEB_OUT: web },
      encoding: "utf8",
    });
    assert.equal(built.status, 0, built.stderr);
    const data = longConversation(N, N);
    const host = await startWebHost({ dir: web, controller: controllerOver(data) });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.addInitScript({ path: join(import.meta.dirname, "perf-page.mjs") });
      const loadStart = Date.now();
      await page.goto(host.url);
      await page.getByLabel("Conversation").waitFor();
      await page.getByText("A very long conversation").first().waitFor({ timeout: 120_000 });
      const loadMs = Date.now() - loadStart;

      const scrollChat = await scrollCosts(page, "transcript", 150, TYPICAL_STEP_PX, "end");
      const scrollGraph = await scrollCosts(page, "graph", 150, TYPICAL_STEP_PX, "start");
      const scrollChatFast = await scrollCosts(page, "transcript", 150, FAST_STEP_PX, "end");
      const scrollGraphFast = await scrollCosts(page, "graph", 150, FAST_STEP_PX, "start");
      await page.evaluate("window.__perfKit.toTip()");
      // The first few run code for the first time; a person adding to a long conversation has done so before.
      const all = await addItems(page, WARM_UP_ADDS + 30);
      const added = { chat: all.chat.slice(WARM_UP_ADDS), graph: all.graph.slice(WARM_UP_ADDS) };

      const domNodes: number = await page.evaluate("document.getElementsByTagName('*').length");
      const result = {
        size: N,
        loadMs,
        domNodes,
        addChat: round(stats(added.chat)),
        addGraph: round(stats(added.graph)),
        scrollChat: round(stats(scrollChat)),
        scrollGraph: round(stats(scrollGraph)),
        scrollChatFast: round(stats(scrollChatFast)),
        scrollGraphFast: round(stats(scrollGraphFast)),
      };
      console.log(JSON.stringify(result, null, 2));
      const out = process.env["CHATTREE_PERF_OUT"];
      if (out !== undefined) await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);

      assert.ok(result.addChat.p95 < ADD_BUDGET_MS, `a new message took ${result.addChat.p95} ms to paint (p95), budget ${ADD_BUDGET_MS}`);
      assert.ok(result.addGraph.p95 < ADD_BUDGET_MS, `a new commit took ${result.addGraph.p95} ms to paint (p95), budget ${ADD_BUDGET_MS}`);
      assert.ok(
        result.scrollChat.p95 < SCROLL_BUDGET_MS,
        `a transcript scroll frame cost ${result.scrollChat.p95} ms (p95), budget ${SCROLL_BUDGET_MS}`,
      );
      assert.ok(
        result.scrollGraph.p95 < SCROLL_BUDGET_MS,
        `a graph scroll frame cost ${result.scrollGraph.p95} ms (p95), budget ${SCROLL_BUDGET_MS}`,
      );
    } finally {
      await browser.close();
      await host.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
