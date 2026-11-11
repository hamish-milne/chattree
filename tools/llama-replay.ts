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
 *
 * `--request FILE` replays a request.json saved by an earlier run instead of a wire log, so the same request can be tried again after a
 * change to the settings. Step 4 is run with three samplers (as sent, greedy, and OpenAI's recommendation for gpt-oss: temperature 1,
 * top_k 0, top_p 1, min_p 0) and counts how many answers start as a well-formed harmony message; the first tokens of the greedy answer
 * are printed with the model's top candidates, which shows whether the model is unsure or the sampler is picking from a flat tail.
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

function args(argv: string[]): { wire?: string; request?: string; entry?: number; repeat: number; maxTokens?: number; out: string } {
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i < 0 ? undefined : argv[i + 1];
  };
  const wire = get("--wire");
  const request = get("--request");
  if (wire === undefined && request === undefined) throw new Error("--wire FILE (written by live-sample.ts --wire-log) or --request FILE (a request.json from an earlier replay) is required");
  const entry = get("--entry");
  const maxTokens = get("--max-tokens");
  return { ...(wire === undefined ? {} : { wire }), ...(request === undefined ? {} : { request }), ...(entry === undefined ? {} : { entry: Number(entry) }), repeat: Number(get("--repeat") ?? 10), ...(maxTokens === undefined ? {} : { maxTokens: Number(maxTokens) }), out: get("--out") ?? "replay" };
}

async function main(): Promise<void> {
  const a = args(process.argv.slice(2));
  let e: Entry | undefined;
  if (a.request !== undefined) {
    e = { n: 0, status: 0, failed: true, response: "", request: JSON.parse(await readFile(a.request, "utf8")) as Record<string, unknown> };
    console.log(`replaying ${a.request}`);
  } else {
    const entries = (await readFile(a.wire as string, "utf8")).split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Entry);
    const failed = entries.filter((x) => x.failed);
    console.log(`${entries.length} requests in the log, ${failed.length} failed`);
    e = a.entry === undefined ? failed.at(-1) : entries.find((x) => x.n === a.entry);
    if (e === undefined) throw new Error(a.entry === undefined ? "no request in the log failed" : `no request ${a.entry} in the log`);
    console.log(`replaying request ${e.n} (status ${e.status}); the server said: ${clip(e.response.replace(/\s+/g, " "), 300)}`);
  }

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

  // 4. what the model writes, under three samplers
  const asSent = Object.fromEntries(SAMPLING.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  const variants: [string, Record<string, unknown>][] = [
    ["as sent", asSent],
    ["greedy", { temperature: 0 }],
    ["temperature 1, top_k 0, top_p 1, min_p 0", { temperature: 1, top_k: 0, top_p: 1, min_p: 0 }],
  ];
  // a well-formed harmony message starts with a channel name, and a call names its function
  const wellFormed = /^<\|channel\|>(analysis|commentary|final)( to=functions\.\w+)?\s*(<\|constrain\|>json)?<\|message\|>/;
  for (const [vi, [label, sampling]] of variants.entries()) {
    console.log(`\nthe raw completion of that prompt, ${a.repeat} times, sampler: ${label}`);
    let clean = 0;
    const stops = new Map<string, number>();
    for (let i = 0; i < a.repeat; i++) {
      const probs = vi === 1 && i === 0 ? 5 : 0;
      const r = await post(`${baseUrl}/completion`, { model, prompt, n_predict: maxTokens, cache_prompt: false, stream: false, special: true, ...(probs > 0 ? { n_probs: probs } : {}), ...sampling });
      const j = r.json as { content?: string; stop_type?: string; tokens_predicted?: number; completion_probabilities?: unknown[] } | undefined;
      const text = j?.content ?? r.text;
      await writeFile(join(a.out, `raw-${vi}-${i}.txt`), text);
      const ok = wellFormed.test(text);
      if (ok) clean++;
      stops.set(j?.stop_type ?? `HTTP ${r.status}`, (stops.get(j?.stop_type ?? `HTTP ${r.status}`) ?? 0) + 1);
      console.log(`  #${i}: ${ok ? "well-formed start" : "MALFORMED start"}, ${j?.stop_type ?? `HTTP ${r.status}`}, ${j?.tokens_predicted ?? "?"} tokens; starts ${JSON.stringify(text.slice(0, 110))}`);
      if (probs > 0 && j?.completion_probabilities !== undefined) {
        await writeFile(join(a.out, "probs.json"), JSON.stringify(j.completion_probabilities, null, 2));
        console.log("  the first tokens of that greedy answer, and what else the model had in mind:");
        for (const [k, c] of (j.completion_probabilities as Record<string, unknown>[]).slice(0, 8).entries()) {
          const top = ((c["top_logprobs"] ?? c["probs"]) as Record<string, unknown>[] | undefined) ?? [];
          const show = (t: Record<string, unknown>): string => `${JSON.stringify(t["token"] ?? t["tok_str"])} ${typeof t["logprob"] === "number" ? Math.exp(t["logprob"]).toFixed(2) : typeof t["prob"] === "number" ? t["prob"].toFixed(2) : "?"}`;
          console.log(`    ${k}: ${JSON.stringify(c["token"] ?? c["content"])}   ← ${top.slice(0, 5).map(show).join(", ")}`);
        }
      }
    }
    console.log(`  ${clean} of ${a.repeat} well-formed; stop types: ${[...stops].map(([k, v]) => `${k} ×${v}`).join(", ")} (limit means the token limit cut it off)`);
  }
  console.log(`\nfiles are in ${a.out}/: request.json, props.json, chat-template.jinja, prompt.txt, chat-N.json, raw-<sampler>-<n>.txt, probs.json`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
});
