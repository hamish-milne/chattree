/**
 * Replay a request a llama-server answered badly, to see what the model actually wrote (docs/local-models.md, 8.2).
 *
 *   node tools/live-sample.ts --flavor local-models --model gpt-oss-20b --task "one line" --repeat 20 --wire-log wire.jsonl
 *   node tools/llama-replay.ts --wire wire.jsonl [--entry N] [--repeat 10] [--max-tokens 16384] [--out replay/]
 *
 * It takes a request from the wire log (the last failed one, or --entry N), then:
 *   1. saves the server's chat template and what it says it can do (`/props`);
 *   2. sends the same request to the chat endpoint --repeat times, without streaming, and counts how each answer ends;
 *   3. renders the request's messages and tools through the template (`/apply-template`) and saves the prompt, which is how the model sees it;
 *   4. sends that prompt to the plain completion endpoint --repeat times with the same sampling: the text that comes back is what the
 *      server's tool-call parser was given, and `stop_type` says whether the model finished or hit the token limit.
 * Everything is written to --out (default ./replay), and a summary printed. The model host must be running (`chattree models start`).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeIo } from "../cli/io.ts";
import { localRuntime } from "../cli/providers.ts";
import { loadSettings } from "../cli/settings.ts";

interface Entry {
  n: number;
  status: number;
  failed: boolean;
  response: string;
  request: Record<string, unknown>;
}

const SAMPLING = ["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "presence_penalty", "frequency_penalty", "seed"] as const;

async function post(url: string, body: unknown, timeoutMs = 600_000): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…[${s.length - n} more]`);

function args(argv: string[]): { wire: string; entry?: number; repeat: number; maxTokens?: number; out: string } {
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i < 0 ? undefined : argv[i + 1];
  };
  const wire = get("--wire");
  if (wire === undefined) throw new Error("--wire FILE is required (written by live-sample.ts --wire-log)");
  const entry = get("--entry");
  const maxTokens = get("--max-tokens");
  return { wire, ...(entry === undefined ? {} : { entry: Number(entry) }), repeat: Number(get("--repeat") ?? 10), ...(maxTokens === undefined ? {} : { maxTokens: Number(maxTokens) }), out: get("--out") ?? "replay" };
}

async function main(): Promise<void> {
  const a = args(process.argv.slice(2));
  const entries = (await readFile(a.wire, "utf8")).split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Entry);
  const failed = entries.filter((e) => e.failed);
  console.log(`${entries.length} requests in the log, ${failed.length} failed`);
  const e = a.entry === undefined ? failed.at(-1) : entries.find((x) => x.n === a.entry);
  if (e === undefined) throw new Error(a.entry === undefined ? "no request in the log failed" : `no request ${a.entry} in the log`);
  console.log(`replaying request ${e.n} (status ${e.status}); the server said: ${clip(e.response.replace(/\s+/g, " "), 300)}`);

  const io = nodeIo();
  io.settings = await loadSettings(io);
  const { baseUrl } = await localRuntime(io).connect();
  const body = e.request;
  const model = String(body["model"]);
  await mkdir(a.out, { recursive: true });
  const maxTokens = a.maxTokens ?? (typeof body["max_tokens"] === "number" ? body["max_tokens"] : typeof body["max_completion_tokens"] === "number" ? body["max_completion_tokens"] : 4096);
  await writeFile(join(a.out, "request.json"), JSON.stringify(body, null, 2));

  // 1. the template
  const props = await fetch(`${baseUrl}/props?model=${encodeURIComponent(model)}`).then((r) => r.json() as Promise<Record<string, unknown>>).catch((err: unknown): Record<string, unknown> => ({ error: String(err) }));
  await writeFile(join(a.out, "props.json"), JSON.stringify(props, null, 2));
  if (typeof props["chat_template"] === "string") await writeFile(join(a.out, "chat-template.jinja"), props["chat_template"]);
  console.log(`\ntemplate: ${typeof props["chat_template"] === "string" ? `${props["chat_template"].length} characters, saved` : "not given"}; capabilities: ${JSON.stringify(props["chat_template_caps"] ?? "not given")}`);

  // 2. the same request, again, to the chat endpoint
  console.log(`\nthe chat endpoint, ${a.repeat} times (max_tokens ${maxTokens}):`);
  const tally = new Map<string, number>();
  for (let i = 0; i < a.repeat; i++) {
    const { stream: _s, stream_options: _o, ...rest } = body;
    const r = await post(`${baseUrl}/v1/chat/completions`, { ...rest, stream: false, max_tokens: maxTokens });
    const j = r.json as { choices?: { finish_reason?: string; message?: { content?: string; tool_calls?: { function?: { name?: string } }[] } }[]; error?: { message?: string } } | undefined;
    const c = j?.choices?.[0];
    const outcome = r.status !== 200 ? `HTTP ${r.status}: ${clip(j?.error?.message ?? r.text, 90)}` : `ok, finish ${c?.finish_reason}${(c?.message?.tool_calls?.length ?? 0) > 0 ? `, calls ${c?.message?.tool_calls?.map((t) => t.function?.name).join("+")}` : ", no call"}`;
    tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
    await writeFile(join(a.out, `chat-${i}.json`), r.text);
  }
  for (const [k, v] of [...tally].sort((x, y) => y[1] - x[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);

  // 3. the prompt
  const applied = await post(`${baseUrl}/apply-template`, { model, messages: body["messages"], ...(body["tools"] === undefined ? {} : { tools: body["tools"] }) });
  const prompt = (applied.json as { prompt?: string } | undefined)?.prompt;
  if (prompt === undefined) {
    console.log(`\n/apply-template gave no prompt (HTTP ${applied.status}): ${clip(applied.text, 300)}`);
    return;
  }
  await writeFile(join(a.out, "prompt.txt"), prompt);
  console.log(`\nthe prompt as the model sees it: ${prompt.length} characters, saved; it ends:\n${prompt.slice(-700).replace(/^/gm, "    ")}`);

  // 4. what the model writes
  console.log(`\nthe raw completion of that prompt, ${a.repeat} times:`);
  const sampling = Object.fromEntries(SAMPLING.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  const stops = new Map<string, number>();
  for (let i = 0; i < a.repeat; i++) {
    const r = await post(`${baseUrl}/completion`, { model, prompt, n_predict: maxTokens, cache_prompt: false, stream: false, special: true, ...sampling });
    const j = r.json as { content?: string; stop_type?: string; tokens_predicted?: number } | undefined;
    const text = j?.content ?? r.text;
    await writeFile(join(a.out, `raw-${i}.txt`), text);
    stops.set(j?.stop_type ?? `HTTP ${r.status}`, (stops.get(j?.stop_type ?? `HTTP ${r.status}`) ?? 0) + 1);
    console.log(`  #${i}: ${j?.stop_type ?? `HTTP ${r.status}`}, ${j?.tokens_predicted ?? "?"} tokens; ends ${JSON.stringify(text.slice(-160))}`);
  }
  console.log(`stop types: ${[...stops].map(([k, v]) => `${k} ×${v}`).join(", ")} (limit means the token limit cut it off)`);
  console.log(`\nfiles are in ${a.out}/: request.json, props.json, chat-template.jinja, prompt.txt, chat-N.json, raw-N.txt`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
});
