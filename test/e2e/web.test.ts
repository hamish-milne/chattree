import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { Controller } from "../../ui/controller/controller.ts";
import { nodeHost } from "../../hosts/node.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { startWebHost } from "../../ui/host/web-host.ts";
import { slowOptions } from "../support/slow.ts";
import { playwrightDriver } from "./playwright-driver.ts";
import { journey } from "./journey.ts";
import { diskWorld } from "./world.ts";

/**
 * The whole product in a real browser, driven as a person would: the views over the web host, with the real controller behind
 * it, on a real disk and a real git repository. Only the model is scripted: a local server that speaks the Messages API, which
 * the process's `fetch` is pointed at in place of api.anthropic.com. See docs/map/e2e.md.
 */
const sse = (type: string, data: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const start = sse("message_start", {
  message: {
    id: "m",
    type: "message",
    role: "assistant",
    content: [],
    model: "claude-sonnet-5-5",
    stop_reason: null,
    usage: { input_tokens: 40, output_tokens: 1 },
  },
});

/** The messages of a Messages API request body. */
function messagesOf(body: unknown): { role: string; content: unknown }[] {
  const list: unknown = typeof body === "object" && body !== null && "messages" in body ? body.messages : [];
  const out: { role: string; content: unknown }[] = [];
  if (Array.isArray(list))
    for (const m of list as unknown[])
      if (typeof m === "object" && m !== null && "role" in m && typeof m.role === "string" && "content" in m)
        out.push({ role: m.role, content: m.content });
  return out;
}

/** The scripted model: for a task, think and ask to write the file; once the write is done, say so. */
function scripted(files: Record<string, { content: string; reply: string }>): (n: number, req: { body: string }) => Reply {
  return (_n, req) => {
    const messages = messagesOf(JSON.parse(req.body));
    const last = messages.at(-1);
    const toolDone = JSON.stringify(last?.content).includes("tool_result");
    const taskText = JSON.stringify(
      messages.findLast((m) => m.role === "user" && !JSON.stringify(m.content).includes("tool_result"))?.content,
    );
    const reply = Object.entries(files).find(([k]) => taskText.includes(k))?.[1].reply ?? "Done.";
    if (toolDone)
      return {
        acts: [
          start,
          sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
          sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } }),
          sse("content_block_stop", { index: 0 }),
          sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
          sse("message_stop", {}),
        ],
      };
    const task = JSON.stringify(last?.content);
    const content = Object.entries(files).find(([k]) => taskText.includes(k))?.[1].content ?? "";
    return {
      acts: [
        start,
        sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
        sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "I will write the file." } }),
        sse("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "c2ln" } }),
        sse("content_block_stop", { index: 0 }),
        sse("content_block_start", { index: 1, content_block: { type: "tool_use", id: `toolu_${task.length}`, name: "write", input: {} } }),
        sse("content_block_delta", {
          index: 1,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: "notes.md", content }) },
        }),
        sse("content_block_stop", { index: 1 }),
        sse("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }),
        sse("message_stop", {}),
      ],
    };
  };
}

test("[slow] the journey: an empty folder to delivered files, in a browser", { ...slowOptions, timeout: 180_000 }, async () => {
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

    const model = await FakeServer.start(
      scripted({
        "first line": { content: "first line\n", reply: "Wrote the first line." },
        "second line": { content: "first line\nsecond line\n", reply: "Added the second line." },
      }),
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return realFetch(url.replace("https://api.anthropic.com", model.url), init);
    };
    const host = await startWebHost({
      dir: web,
      controller: (emit) =>
        new Controller({
          env: {
            host: nodeHost(),
            cwd: dir,
            env: { CHATTREE_ENVIRONMENT: "off", CHATTREE_SETTINGS: join(dir, "settings.yml"), ANTHROPIC_API_KEY: "test-key" },
            now: Date.now,
          },
          folders: [join(root, "scratch")],
          send: emit,
          session: "e2e",
          platform: { openFile: async () => {}, copy: async () => {}, pickFiles: async () => [] },
          pollMs: 200,
        }),
    });
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
        asksBeforeWriting: false,
        replies: { first: "Wrote the first line.", second: "Added the second line." },
        tasks: { first: "Write notes.md with a first line", second: "Add a second line to notes.md" },
        deliverable: { path: "notes.md", afterFirst: "first line\n", afterSecond: "first line\nsecond line\n" },
      });
      try {
        await journey(driver, world);
      } catch (e) {
        if (shots !== undefined) await driver.screenshot("failed");
        if (process.env["E2E_TRACE"] !== undefined) {
          const all = page.getByLabel("Message");
          for (let i = 0; i < (await all.count()); i++)
            console.log(
              "MESSAGE",
              i,
              await all.nth(i).isVisible(),
              await all.nth(i).isEditable(),
              await all.nth(i).getAttribute("aria-label"),
            );
        }
        if (process.env["E2E_TRACE"] !== undefined)
          console.log(
            host.log.events
              .slice(-40)
              .map((x) => x.type)
              .join(" "),
            "\n",
            host.log.intents
              .slice(-8)
              .map((i) => (i.type === "file.open" ? `file.open ${i.path}` : i.type))
              .join(", "),
          );
        throw e;
      }
    } finally {
      await browser.close();
      await host.close();
      globalThis.fetch = realFetch;
      await model.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
