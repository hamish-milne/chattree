/**
 * Measure how faithfully a model copies a short string from a file or a tool result into its answer, and where a copy goes
 * wrong. Prompted by gpt-oss writing "PELIPCAN" for "PELICAN" in 3 of 10 answers while the tool result was right.
 *
 *   node tools/copy-probe.ts --flavor anthropic --base-url http://localhost:11434 --model gpt-oss:20b --repeat 5
 *   node tools/copy-probe.ts ... --arms tool,plain,native --temperature 0 --record ./probe/ --out probe.json
 *
 * Three arms, the same sentence ("the code word is X") each time, only X varies:
 *   tool    the real loop: the model reads note.txt with the read tool, then answers (our whole path, tools included);
 *   plain   our adapter, no tools: the sentence is pasted in the prompt (our request and response mapping, no tools);
 *   native  Ollama's own /api/chat, no tools, no harness (the control: nothing of ours is involved). Needs --ollama-url,
 *           which defaults to the base URL without a trailing /v1.
 * If a typo shows up in native too, it is the model or the runtime. If only in plain or tool, look at our mapping or the
 * server's translation layer. Each sample records the model's reasoning (the thinking text), so a typo can be placed: already
 * in the reasoning, or only in the answer.
 *
 * Flags: --flavor, --base-url, --model, --api-key-env NAME, --repeat N (per item, default 5), --arms LIST, --temperature N,
 * --reasoning-effort low|medium|high (sent as reasoning_effort on openai-compatible and as `think` on native), --max-tokens
 * (default 4096), --ollama-url URL, --timeout-seconds (per sample, default 180), --busybox PATH, --out FILE, --record DIR, --list.
 * Settings you do not give are not sent, so the server's own defaults apply (what a user gets).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptySetup, type AgentSetup } from "../harness/setup.ts";
import type { ModelContext } from "../harness/context-builder.ts";
import { collectStream, type StreamRun } from "../providers/conformance.ts";
import type { ProviderAdapter } from "../providers/types.ts";
import { findBusybox } from "../hosts/node.ts";
import { runAgentTask } from "./agent-task.ts";
import { FLAVORS, makeAdapter, type Flavor } from "./live-check.ts";

export const ARMS = ["tool", "plain", "native"] as const;
export type Arm = (typeof ARMS)[number];

export interface Item {
  /** What kind of string: caps word, lowercase word, identifier, hex digest, random capitals. */
  kind: string;
  text: string;
}

/** A small deterministic generator, so the random items are the same on every run. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The strings copied: the words from the sampler's tasks, the same words in lowercase, identifiers, the 8-hex versions `edit` uses, and seeded random capitals. */
export function makeItems(seed = 7): Item[] {
  const words = ["PELICAN", "WALRUS", "MARMOT", "ORCHID", "ZEBRA", "LANTERN"];
  const rnd = prng(seed);
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const random = Array.from({ length: 4 }, () => Array.from({ length: 8 }, () => letters[Math.floor(rnd() * 26)] as string).join(""));
  return [
    ...words.map((text): Item => ({ kind: "caps word", text })),
    ...words.map((text): Item => ({ kind: "lower word", text: text.toLowerCase() })),
    ...["calculateTotalPrice", "parse_http_header", "maxRetryCount", "getUserById"].map((text): Item => ({ kind: "identifier", text })),
    ...["1f08cd1f", "4fdbc441", "e3f38a2a", "56451000"].map((text): Item => ({ kind: "hex8", text })),
    ...random.map((text): Item => ({ kind: "random caps", text })),
  ];
}

export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j] as number;
      row[j] = Math.min(keep + 1, (row[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length] as number;
}

export type Verdict = { kind: "exact" } | { kind: "near"; got: string; distance: number } | { kind: "other" };

/** Did the answer contain the string whole (`exact`), something within two edits of it (`near`, the typo we are after), or neither. */
export function judge(answer: string, expected: string): Verdict {
  const tokens: string[] = answer.match(/[A-Za-z0-9_]+/g) ?? [];
  if (tokens.includes(expected)) return { kind: "exact" };
  let best: { got: string; distance: number } | undefined;
  for (const t of tokens) {
    if (t.length < 3) continue;
    const d = t.toLowerCase() === expected.toLowerCase() ? 1 : distance(t, expected);
    if (d <= 2 && (best === undefined || d < best.distance)) best = { got: t, distance: d };
  }
  return best === undefined ? { kind: "other" } : { kind: "near", ...best };
}

/** Where a wrong copy happened, judged from the reasoning text. */
export function place(reasoning: string, expected: string, got: string | undefined): string {
  if (reasoning === "") return "no reasoning captured";
  if (got !== undefined && reasoning.includes(got)) return "already wrong in the reasoning";
  if (reasoning.includes(expected)) return "right in the reasoning, wrong in the answer";
  return "the reasoning has neither";
}

export type NativeChat = (req: { prompt: string; signal: AbortSignal }) => Promise<{ content: string; thinking: string }>;

/** Ollama's own chat endpoint: no tools, no translation layer, no harness. */
export function ollamaNative(o: { url: string; model: string; temperature?: number | undefined; think?: string | undefined }): NativeChat {
  return async ({ prompt, signal }) => {
    const body = { model: o.model, stream: false, messages: [{ role: "user", content: prompt }], ...(o.think === undefined ? {} : { think: o.think }), ...(o.temperature === undefined ? {} : { options: { temperature: o.temperature } }) };
    const res = await fetch(`${o.url.replace(/\/+$/, "")}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { message?: { content?: string; thinking?: string } };
    return { content: j.message?.content ?? "", thinking: j.message?.thinking ?? "" };
  };
}

export interface ProbeOptions {
  flavor: Flavor;
  baseUrl: string;
  model: string;
  apiKey?: string;
  repeat?: number;
  arms?: readonly Arm[];
  temperature?: number;
  reasoningEffort?: string;
  maxTokens?: number;
  ollamaUrl?: string;
  timeoutSeconds?: number;
  busybox?: string | undefined;
  items?: readonly Item[];
  /** For tests. */
  adapter?: ProviderAdapter;
  native?: NativeChat;
  onSample?: (s: ProbeSample, done: number, total: number) => void;
}

export interface ProbeSample {
  arm: Arm;
  kind: string;
  expected: string;
  n: number;
  verdict: Verdict;
  /** For a wrong copy: where it happened. */
  placed?: string;
  answer: string;
  reasoning: string;
  error?: string;
  ms: number;
}

const SENTENCE = (x: string): string => `the code word is ${x}`;
export const PLAIN_PROMPT = (x: string): string => `Here is the content of note.txt:\n\n${SENTENCE(x)}\n\nWhat is the code word? Answer with just the code word.`;
export const TOOL_PROMPT = "What is the code word in note.txt? Answer with just the code word.";

const reasoningOf = (run: Pick<StreamRun, "completed">): string => (run.completed?.blocks ?? []).flatMap((b) => (b.type === "reasoning" && b.visible !== undefined ? [b.visible] : [])).join("\n");
const textOf = (run: Pick<StreamRun, "completed">): string => (run.completed?.blocks ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");

export async function runProbe(o: ProbeOptions): Promise<ProbeSample[]> {
  const adapter = o.adapter ?? makeAdapter(o);
  const arms = o.arms ?? ARMS;
  const repeat = o.repeat ?? 5;
  const items = o.items ?? makeItems();
  const settings: Record<string, unknown> = { max_output_tokens: o.maxTokens ?? 4096, ...(o.temperature === undefined ? {} : { temperature: o.temperature }), ...(o.reasoningEffort !== undefined && o.flavor === "openai-compatible" ? { reasoning_effort: o.reasoningEffort } : {}) };
  const model = { provider: "live", id: o.model, settings } as NonNullable<AgentSetup["model"]>;
  const setup: AgentSetup = { ...emptySetup(), model };
  const native = o.native ?? ollamaNative({ url: o.ollamaUrl ?? o.baseUrl.replace(/\/v1\/?$/, ""), model: o.model, temperature: o.temperature, think: o.reasoningEffort });
  const timeoutMs = (o.timeoutSeconds ?? 180) * 1000;
  const out: ProbeSample[] = [];
  const total = arms.length * items.length * repeat;
  for (const arm of arms) {
    for (const item of items) {
      for (let n = 1; n <= repeat; n++) {
        const t0 = Date.now();
        let answer = "";
        let reasoning = "";
        let error: string | undefined;
        try {
          if (arm === "tool") {
            const runs: StreamRun[] = [];
            const r = await runAgentTask({ adapter, model, busybox: o.busybox, files: { "note.txt": `${SENTENCE(item.text)}\n` }, prompt: TOOL_PROMPT, timeoutMs, onRequest: (run) => void runs.push(run) });
            answer = r.answer;
            reasoning = runs.map(reasoningOf).filter((t) => t !== "").join("\n---\n");
            if (!r.used.has("read")) error = "the model did not call read";
          } else if (arm === "plain") {
            const context: ModelContext = { system: "You are terse. Follow instructions exactly.", instructions: undefined, turns: [{ role: "user", parts: [{ type: "text", text: PLAIN_PROMPT(item.text) }] }], tools: [], cacheHints: [] };
            const run = await collectStream(adapter.stream({ context, setup, signal: AbortSignal.timeout(timeoutMs) }));
            if (run.error !== undefined) throw run.error;
            answer = textOf(run);
            reasoning = reasoningOf(run);
          } else {
            const r = await native({ prompt: PLAIN_PROMPT(item.text), signal: AbortSignal.timeout(timeoutMs) });
            answer = r.content;
            reasoning = r.thinking;
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        const verdict = judge(answer, item.text);
        const s: ProbeSample = { arm, kind: item.kind, expected: item.text, n, verdict, ...(verdict.kind === "exact" ? {} : { placed: place(reasoning, item.text, verdict.kind === "near" ? verdict.got : undefined) }), answer, reasoning, ...(error === undefined ? {} : { error }), ms: Date.now() - t0 };
        out.push(s);
        o.onSample?.(s, out.length, total);
      }
    }
  }
  return out;
}

const frac = (a: number, b: number): string => (b === 0 ? "-" : `${a}/${b}`);

export function formatProbeReport(samples: readonly ProbeSample[], o: Pick<ProbeOptions, "flavor" | "model" | "repeat" | "temperature" | "reasoningEffort">): string {
  const arms = ARMS.filter((a) => samples.some((s) => s.arm === a));
  const kinds = [...new Set(samples.map((s) => s.kind))];
  const lines: string[] = [];
  lines.push(`${o.flavor} ${o.model}: copy fidelity, ${o.repeat ?? 5} samples per string, temperature ${o.temperature ?? "server default"}, reasoning effort ${o.reasoningEffort ?? "server default"}`, "");
  const w = Math.max(...kinds.map((k) => k.length), 5);
  lines.push(`${"".padEnd(w)}  ${arms.map((a) => a.padStart(8)).join("  ")}`);
  for (const k of [...kinds, "all"]) {
    const cells = arms.map((a) => {
      const mine = samples.filter((s) => s.arm === a && (k === "all" || s.kind === k));
      return frac(mine.filter((s) => s.verdict.kind === "exact").length, mine.length).padStart(8);
    });
    lines.push(`${k.padEnd(w)}  ${cells.join("  ")}`);
  }
  const near = samples.filter((s) => s.verdict.kind === "near");
  const other = samples.filter((s) => s.verdict.kind === "other");
  const errors = samples.filter((s) => s.error !== undefined);
  if (near.length > 0) {
    lines.push("", "near misses (a typo in the copy):");
    for (const s of near) lines.push(`  ${s.arm.padEnd(6)} ${s.expected} -> ${s.verdict.kind === "near" ? s.verdict.got : ""}   ${s.placed}`);
    const where = new Map<string, number>();
    for (const s of near) where.set(`${s.arm}: ${s.placed}`, (where.get(`${s.arm}: ${s.placed}`) ?? 0) + 1);
    lines.push("", "where they happened:");
    for (const [k, c] of [...where].sort()) lines.push(`  ${String(c).padStart(3)}  ${k}`);
  }
  if (other.length > 0) lines.push("", `${other.length} answer(s) held neither the string nor a near copy; first: ${other[0]?.arm} ${JSON.stringify(other[0]?.answer.slice(0, 80))}`);
  if (errors.length > 0) lines.push("", `${errors.length} sample(s) had an error; first: ${errors[0]?.arm} ${errors[0]?.error?.slice(0, 120)}`);
  return lines.join("\n");
}

export function parseProbeArgs(argv: readonly string[], env: Record<string, string | undefined>): { options: ProbeOptions; out?: string; record?: string; list: boolean } {
  const flags = new Map<string, string>();
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--list") list = true;
    else if (a.startsWith("--")) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      flags.set(a, v);
    } else throw new Error(`unexpected argument ${a}`);
  }
  const known = new Set(["--flavor", "--base-url", "--model", "--api-key-env", "--repeat", "--arms", "--temperature", "--reasoning-effort", "--max-tokens", "--ollama-url", "--timeout-seconds", "--busybox", "--out", "--record"]);
  for (const k of flags.keys()) if (!known.has(k)) throw new Error(`unknown flag ${k}`);
  const flavor = flags.get("--flavor") ?? "anthropic";
  if (!(FLAVORS as readonly string[]).includes(flavor)) throw new Error(`--flavor must be one of ${FLAVORS.join(", ")}`);
  const baseUrl = flags.get("--base-url");
  const model = flags.get("--model");
  if (!list && (baseUrl === undefined || model === undefined)) throw new Error("--base-url and --model are required");
  const int = (name: string): number | undefined => {
    const v = flags.get(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of at least 1`);
    return n;
  };
  const armList = flags.get("--arms")?.split(",").map((a) => a.trim());
  for (const a of armList ?? []) if (!(ARMS as readonly string[]).includes(a)) throw new Error(`--arms must be a list of ${ARMS.join(", ")}`);
  const temp = flags.get("--temperature");
  if (temp !== undefined && (!Number.isFinite(Number(temp)) || Number(temp) < 0)) throw new Error("--temperature must be a number, 0 or more");
  const keyEnv = flags.get("--api-key-env");
  let apiKey: string | undefined;
  if (keyEnv !== undefined) {
    apiKey = env[keyEnv];
    if (apiKey === undefined || apiKey === "") throw new Error(`the environment variable ${keyEnv} is not set`);
  }
  const repeat = int("--repeat");
  const maxTokens = int("--max-tokens");
  const timeout = int("--timeout-seconds");
  const effort = flags.get("--reasoning-effort");
  if (effort !== undefined && !["low", "medium", "high"].includes(effort)) throw new Error("--reasoning-effort must be low, medium or high");
  const ollama = flags.get("--ollama-url");
  const busybox = flags.get("--busybox");
  const out = flags.get("--out");
  const record = flags.get("--record");
  return {
    options: {
      flavor: flavor as Flavor,
      baseUrl: baseUrl ?? "",
      model: model ?? "",
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(repeat === undefined ? {} : { repeat }),
      ...(armList === undefined ? {} : { arms: armList as Arm[] }),
      ...(temp === undefined ? {} : { temperature: Number(temp) }),
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(ollama === undefined ? {} : { ollamaUrl: ollama }),
      ...(timeout === undefined ? {} : { timeoutSeconds: timeout }),
      ...(busybox === undefined ? {} : { busybox }),
    },
    ...(out === undefined ? {} : { out }),
    ...(record === undefined ? {} : { record }),
    list,
  };
}

async function main(): Promise<void> {
  const { options, out, record, list } = parseProbeArgs(process.argv.slice(2), process.env);
  if (list) {
    for (const i of makeItems()) console.log(`${i.kind.padEnd(12)} ${i.text}`);
    return;
  }
  const busybox = options.busybox ?? (await findBusybox());
  const secrets = options.apiKey === undefined ? [] : [options.apiKey];
  const scrub = (text: string): string => secrets.reduce((t, s) => t.split(s).join("[redacted]"), text);
  if (record !== undefined) await mkdir(record, { recursive: true });
  const samples = await runProbe({
    ...options,
    busybox,
    onSample: (s, done, total) => {
      console.error(`[${done}/${total}] ${s.arm} ${s.expected} #${s.n}: ${s.error !== undefined ? `ERROR ${s.error.slice(0, 60)}` : s.verdict.kind === "exact" ? "ok" : s.verdict.kind === "near" ? `TYPO ${s.verdict.got} (${s.placed})` : "other"}  ${(s.ms / 1000).toFixed(1)}s`);
      if (record !== undefined) void writeFile(join(record, `${s.arm}-${s.expected}-${String(s.n).padStart(2, "0")}.json`), scrub(JSON.stringify(s, null, 2)));
    },
  });
  console.log(`\n${scrub(formatProbeReport(samples, options))}`);
  if (out !== undefined) await writeFile(out, scrub(JSON.stringify({ options: { ...options, apiKey: undefined }, samples }, null, 2)));
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  });
}
