/**
 * How each local model's own chat template treats the situations a tool-calling agent produces (docs/local-models.md, 9.4 step 1).
 *
 *   node tools/template-compare.ts [--model NAME ...] [--live] [--out templates-run/]
 *
 * For each model (default: every model in the settings) on the running host, it saves the chat template (`/props`) and renders a fixed set of
 * scenarios through it (`/apply-template`): the prompt exactly as the model would see it. It prints whether the reasoning kept in the history
 * reached the prompt, and how a nested tool schema was declared. With --live it also asks the model for the start of its next message
 * (greedy, `/completion`, with the top candidates for the first tokens), which shows whether the model is comfortable with what it was shown.
 * Nothing is sent to the models' own tool-call parsers: this is the prompt and the raw text only. The model host must be running.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { nodeIo } from "../cli/io.ts";
import { localRuntime } from "../cli/providers.ts";
import { loadSettings } from "../cli/settings.ts";

type Json = Record<string, unknown>;
export interface Scenario {
  name: string;
  about: string;
  messages: Json[];
  tools: Json[];
  /** Text that was put in earlier reasoning: whether it is in the prompt says whether the template keeps it. */
  reasoningMarks: string[];
}

const fn = (name: string, description: string, properties: Json, required: string[]): Json => ({
  type: "function",
  function: { name, description, parameters: { type: "object", additionalProperties: false, properties, required } },
});

export const READ = fn("read", "Read a file. Returns its lines, numbered, and its version.", { path: { type: "string", description: "Path of the file, relative to the workspace root." }, limit: { type: "integer", description: "At most this many lines." } }, ["path"]);
export const WRITE = fn("write", "Create a file, or replace one whole. Give the complete new content.", { path: { type: "string", description: "Path of the file." }, content: { type: "string", description: "The complete new content of the file." } }, ["path", "content"]);
export const RECORD = fn(
  "record_items",
  "Record the items of an order.",
  {
    customer: { type: "string", description: "Who the order is for." },
    items: {
      type: "array",
      description: "The items ordered.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { sku: { type: "string", description: "The product code." }, quantity: { type: "integer", description: "How many." }, options: { type: "array", description: "Chosen options.", items: { type: "string" } } },
        required: ["sku", "quantity"],
      },
    },
  },
  ["customer", "items"],
);

const SYSTEM = { role: "system", content: "You are a terse coding agent working in a workspace. Use the tools; do not guess file contents." };
const user = (content: string): Json => ({ role: "user", content });
const call = (id: string, name: string, args: unknown, extra: Json = {}): Json => ({ role: "assistant", content: null, ...extra, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const result = (id: string, content: string): Json => ({ role: "tool", tool_call_id: id, content });

const MULTILINE = 'def greet(name):\n    """Say "hello" to name."""\n    print(f"hello, {name}!\\n")\n\nif __name__ == "__main__":\n    greet("world")\n';

export function scenarios(): Scenario[] {
  return [
    {
      name: "one-call",
      about: "A call and its result, then the model's turn.",
      messages: [SYSTEM, user("In notes.txt change the word draft to final."), call("c1", "read", { path: "notes.txt" }), result("c1", "=== notes.txt (1 line, version 1f08cd1f) ===\n1\tstatus: draft")],
      tools: [READ, WRITE],
      reasoningMarks: [],
    },
    {
      name: "reasoning-between-calls",
      about: "Two calls, each with the model's reasoning. Is the reasoning in the prompt?",
      messages: [
        SYSTEM,
        user("Copy a.txt to b.txt."),
        call("c1", "read", { path: "a.txt" }, { reasoning_content: "MARK-ALPHA I should read a.txt first, to know what to copy." }),
        result("c1", "=== a.txt (1 line, version 11111111) ===\n1\thello"),
        call("c2", "write", { path: "b.txt", content: "hello\n" }, { reasoning_content: "MARK-BETA The file says hello, so b.txt gets the same line." }),
        result("c2", "wrote b.txt (1 line)"),
      ],
      tools: [READ, WRITE],
      reasoningMarks: ["MARK-ALPHA", "MARK-BETA"],
    },
    {
      name: "after-final-answer",
      about: "A finished exchange with its reasoning, then a new user message. Is the old reasoning dropped?",
      messages: [SYSTEM, user("What is 2 + 2?"), { role: "assistant", content: "4.", reasoning_content: "MARK-GAMMA Simple arithmetic: two and two is four." }, user("And 9 / 2?")],
      tools: [READ, WRITE],
      reasoningMarks: ["MARK-GAMMA"],
    },
    {
      name: "nested-schema",
      about: "How a tool with a list of objects (with a list inside) is declared. No history.",
      messages: [SYSTEM, user("Record an order for Ada: two of SKU-1 with options gift and rush, and one SKU-9.")],
      tools: [RECORD],
      reasoningMarks: [],
    },
    {
      name: "multiline-argument",
      about: "A call whose argument has newlines, quotes and backslashes, in the history. How is it written?",
      messages: [SYSTEM, user("Write hello.py"), call("c1", "write", { path: "hello.py", content: MULTILINE }), result("c1", "wrote hello.py (6 lines)"), user("Now read it back.")],
      tools: [READ, WRITE],
      reasoningMarks: [],
    },
    {
      name: "error-result",
      about: "A tool result that is an error.",
      messages: [SYSTEM, user("Read missing.txt"), call("c1", "read", { path: "missing.txt" }), result("c1", "error: missing.txt does not exist")],
      tools: [READ, WRITE],
      reasoningMarks: [],
    },
    {
      name: "two-calls-at-once",
      about: "One assistant message with two calls, and two results.",
      messages: [
        SYSTEM,
        user("Read a.txt and b.txt."),
        { role: "assistant", content: null, tool_calls: [
          { id: "c1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } },
          { id: "c2", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "b.txt" }) } },
        ] },
        result("c1", "=== a.txt (1 line, version 11111111) ===\n1\talpha"),
        result("c2", "=== b.txt (1 line, version 22222222) ===\n1\tbeta"),
      ],
      tools: [READ, WRITE],
      reasoningMarks: [],
    },
  ];
}

export interface CompareOptions {
  out: string;
  live: boolean;
  fetch?: typeof fetch | undefined;
  log?: ((line: string) => void) | undefined;
}

async function post(f: typeof fetch, url: string, body: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(900_000) });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`);

/** The region of a prompt that declares `name`: from its first appearance, a few lines. */
export function declarationOf(prompt: string, name: string): string {
  const i = prompt.indexOf(name);
  return i < 0 ? "(the tool is not in the prompt)" : prompt.slice(Math.max(0, i - 40), i + 700);
}

export async function compare(baseUrl: string, models: string[], o: CompareOptions): Promise<void> {
  const f = o.fetch ?? fetch;
  const log = o.log ?? console.log;
  const all = scenarios();
  await mkdir(o.out, { recursive: true });
  await writeFile(join(o.out, "scenarios.json"), JSON.stringify(all, null, 2));
  for (const model of models) {
    const dir = join(o.out, model.replace(/[^\w.-]+/g, "_"));
    await mkdir(dir, { recursive: true });
    log(`\n######## ${model}`);
    const props = await f(`${baseUrl}/props?model=${encodeURIComponent(model)}`).then((r) => r.json() as Promise<Json>).catch((e: unknown): Json => ({ error: String(e) }));
    await writeFile(join(dir, "props.json"), JSON.stringify(props, null, 2));
    if (typeof props["chat_template"] === "string") await writeFile(join(dir, "chat-template.jinja"), props["chat_template"]);
    log(`template: ${typeof props["chat_template"] === "string" ? `${props["chat_template"].length} characters` : "not given"}; capabilities: ${JSON.stringify(props["chat_template_caps"] ?? "not given")}`);
    for (const s of all) {
      await writeFile(join(dir, `${s.name}.request.json`), JSON.stringify({ model, messages: s.messages, tools: s.tools }, null, 2));
      const r = await post(f, `${baseUrl}/apply-template`, { model, messages: s.messages, tools: s.tools });
      const prompt = (r.json as { prompt?: string } | undefined)?.prompt;
      log(`\n--- ${s.name}: ${s.about}`);
      if (prompt === undefined) {
        log(`  the template refused it (HTTP ${r.status}): ${clip(r.text.replace(/\s+/g, " "), 300)}`);
        await writeFile(join(dir, `${s.name}.error.txt`), r.text);
        continue;
      }
      await writeFile(join(dir, `${s.name}.prompt.txt`), prompt);
      log(`  prompt: ${prompt.length} characters`);
      for (const m of s.reasoningMarks) log(`  reasoning ${m} in the prompt: ${prompt.includes(m) ? "yes" : "NO, dropped"}`);
      if (s.name === "multiline-argument") {
        const i = prompt.indexOf("greet");
        log(`  the argument as written in the history: ${JSON.stringify(prompt.slice(Math.max(0, i - 20), i + 200))}`);
      }
      if (s.name === "nested-schema") log(`  the schema as declared:\n${declarationOf(prompt, "record_items").replace(/^/gm, "    ")}`);
      else log(`  the prompt ends: ${JSON.stringify(prompt.slice(-260))}`);
      if (!o.live) continue;
      const c = await post(f, `${baseUrl}/completion`, { model, prompt, n_predict: 300, temperature: 0, cache_prompt: false, stream: false, special: true, n_probs: 3 });
      const j = c.json as { content?: string; stop_type?: string; tokens_predicted?: number; completion_probabilities?: Json[] } | undefined;
      const text = j?.content ?? c.text;
      await writeFile(join(dir, `${s.name}.raw.txt`), text);
      if (j?.completion_probabilities !== undefined) await writeFile(join(dir, `${s.name}.probs.json`), JSON.stringify(j.completion_probabilities, null, 2));
      log(`  the model writes (greedy, ${j?.stop_type ?? `HTTP ${c.status}`}, ${j?.tokens_predicted ?? "?"} tokens): ${JSON.stringify(clip(text, 260))}`);
      const first = (j?.completion_probabilities ?? []).slice(0, 4).map((p) => `${JSON.stringify(p["token"] ?? p["content"])}`);
      if (first.length > 0) log(`  its first tokens: ${first.join(" ")}`);
    }
  }
  log(`\nFiles are in ${o.out}/: scenarios.json, then per model: props.json, chat-template.jinja, <scenario>.request.json, <scenario>.prompt.txt${o.live ? ", <scenario>.raw.txt, <scenario>.probs.json" : ""}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const names: string[] = [];
  let out = "templates-run";
  let live = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--model") names.push(argv[++i] ?? "");
    else if (a === "--out") out = argv[++i] ?? out;
    else if (a === "--live") live = true;
    else throw new Error(`unknown argument ${a}`);
  }
  const io = nodeIo();
  io.settings = await loadSettings(io);
  const config = io.settings.local_models;
  if (config === undefined) throw new Error("the settings file has no local_models section");
  const runtime = localRuntime(io);
  const { baseUrl } = await runtime.connect();
  const models = names.length > 0 ? names.map((n) => runtime.resolve(n)) : Object.keys(config.models);
  await compare(baseUrl, models, { out, live });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  });
}
