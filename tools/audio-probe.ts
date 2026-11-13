/**
 * Can a local model hear? Sounds made on the fly (tools/audio-scenarios.ts: how many beeps, which of two tones is higher, which is louder)
 * go to the model one at a time with their question, and the answers are checked. Recordings of speech can be added from a folder of
 * `name.wav` files, with the words said in `name.txt` to score them (see tools/audio-samples.ts for a set). The sounds are written next to the results, so a wrong answer can be listened to.
 *
 *   node tools/audio-probe.ts --model NAME [--count 5] [--seed 1] [--kinds beeps,pitch] [--speech DIR] [--dialect NAME] [--max-tokens 1024] [--out DIR] [--yes]
 *
 * `--model` is a name from local_models in the settings file whose projector can hear (Gemma 4 E2B and E4B, Qwen Omni, Voxtral, Ultravox
 * have one, and llama-server says in `/props` whether the one loaded does). `--dialect NAME` sends the sound through that dialect's
 * `/completion` and not the chat endpoint (which takes it as `input_audio`).
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeIo } from "../cli/io.ts";
import { ensureLocalModels } from "../cli/models.ts";
import { lookupSampling } from "../cli/providers.ts";
import { loadSettings } from "../cli/settings.ts";
import type { ModelContext } from "../harness/context-builder.ts";
import { emptySetup, type AgentSetup } from "../harness/setup.ts";
import { samplingSettings } from "../localmodels/catalog.ts";
import { collectStream } from "../providers/conformance.ts";
import { AUDIO_KINDS, listenScenario, scenarios, speechScenario, type AudioKind, type AudioScenario } from "./audio-scenarios.ts";
import { localModelsAdapter } from "./local-adapter.ts";

export interface AudioResult {
  id: string;
  kind: AudioKind;
  expected: string;
  answer: string;
  right: boolean;
  error?: string;
  ms: number;
  stop?: string | undefined;
  tokens?: { in: number; out: number; reasoning?: number | undefined };
  reasoning?: string | undefined;
  blocks?: string[];
}

function args(argv: readonly string[]) {
  const v = (f: string): string | undefined => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const model = v("--model");
  if (model === undefined) throw new Error("--model is required: a model from local_models in the settings file, with a projector that can hear");
  const kinds = v("--kinds")?.split(",").map((k) => k.trim());
  for (const k of kinds ?? []) if (!(AUDIO_KINDS as readonly string[]).includes(k)) throw new Error(`--kinds: ${k} is not one of ${AUDIO_KINDS.join(", ")}`);
  return { model, count: Number(v("--count") ?? 5), seed: Number(v("--seed") ?? 1), kinds: kinds as AudioKind[] | undefined, speech: v("--speech"), maxTokens: Number(v("--max-tokens") ?? 1024), dialect: v("--dialect"), out: v("--out"), yes: argv.includes("--yes") };
}

/** The table of results: right of total for each kind, and the wrong answers. */
export function report(results: readonly AudioResult[]): string {
  const lines = ["| kind | right | of |", "|---|---|---|"];
  for (const k of AUDIO_KINDS) {
    const rs = results.filter((r) => r.kind === k);
    if (rs.length > 0) lines.push(k === "listen" ? `| listen (unscored) | - | ${rs.length} |` : `| ${k} | ${rs.filter((r) => r.right).length} | ${rs.length} |`);
  }
  const scored = results.filter((r) => r.kind !== "listen");
  lines.push(`| all scored | ${scored.filter((r) => r.right).length} | ${scored.length} |`);
  const wrong = results.filter((r) => !r.right);
  const heard = results.filter((r) => r.kind === "listen");
  if (heard.length > 0) {
    lines.push("", "Heard (to be read, not scored):", "");
    for (const r of heard) lines.push(`- ${r.id}: ${r.error !== undefined ? `error: ${r.error}` : JSON.stringify(r.answer.slice(0, 400))}`);
  }
  if (wrong.length > 0) {
    lines.push("", "Wrong:", "");
    for (const r of wrong) lines.push(`- ${r.id}: expected ${r.expected}; ${r.error !== undefined ? `error: ${r.error}` : `answered ${JSON.stringify(r.answer.slice(0, 200))}`}${r.stop === undefined || r.stop === "end_turn" ? "" : ` [${r.stop}]`}${r.tokens === undefined ? "" : ` (${r.tokens.out} tokens out)`}`);
  }
  return lines.join("\n");
}

/**
 * The recordings in a folder: each `name.wav`, with the words said in `name.txt` (scored: the answer must hold them), or without one (a
 * `listen` scenario, read by eye). `name.q`, when there is one, is the question to ask instead of the usual.
 */
export async function readSpeech(dir: string): Promise<AudioScenario[]> {
  const out: AudioScenario[] = [];
  for (const f of (await readdir(dir)).sort()) {
    if (!f.endsWith(".wav")) continue;
    const name = f.slice(0, -4);
    const said = await readFile(join(dir, `${name}.txt`), "utf8").catch(() => undefined);
    const question = (await readFile(join(dir, `${name}.q`), "utf8").catch(() => undefined))?.trim();
    const wav = await readFile(join(dir, f));
    out.push(said === undefined ? listenScenario(name, wav, question) : speechScenario(name, wav, said, question));
  }
  return out;
}

async function main(): Promise<void> {
  const o = args(process.argv.slice(2));
  const io = nodeIo();
  io.settings = await loadSettings(io);
  await ensureLocalModels(io, { yes: o.yes });
  const adapter = localModelsAdapter(io);
  const sampling = samplingSettings((await lookupSampling(io, o.model)).values) as Record<string, unknown>;
  const model = { provider: "live", id: o.model, settings: { max_output_tokens: o.maxTokens, ...sampling, ...(o.dialect === undefined ? {} : { dialect: o.dialect }) } } as NonNullable<AgentSetup["model"]>;
  const setup: AgentSetup = { ...emptySetup(), model };
  const dir = o.out ?? join("bench-runs", `audio-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  await mkdir(dir, { recursive: true });
  const all = [...scenarios({ kinds: o.kinds, count: o.count, seed: o.seed }), ...(o.speech === undefined ? [] : await readSpeech(o.speech))];
  const results: AudioResult[] = [];
  for (const s of all) {
    await writeFile(join(dir, `${s.id}.wav`), s.wav);
    results.push(await ask(adapter, setup, s));
    const r = results[results.length - 1] as AudioResult;
    console.error(`${r.id}: ${r.right ? "right" : "wrong"} (${r.ms} ms) ${r.right ? "" : `expected ${r.expected}, got ${JSON.stringify(r.answer.slice(0, 80))}${r.error === undefined ? "" : ` ${r.error}`}`}`);
  }
  const text = report(results);
  await writeFile(join(dir, "audio.json"), JSON.stringify(results, null, 2));
  await writeFile(join(dir, "run.json"), JSON.stringify({ model: o.model, dialect: o.dialect, maxTokens: o.maxTokens, seed: o.seed, sampling }, null, 2));
  await writeFile(join(dir, "audio.md"), text);
  console.log(text);
}

async function ask(adapter: ReturnType<typeof localModelsAdapter>, setup: AgentSetup, s: AudioScenario): Promise<AudioResult> {
  const t0 = Date.now();
  const context: ModelContext = {
    system: "You are terse. Answer only what is asked.",
    instructions: undefined,
    turns: [{ role: "user", parts: [{ type: "attachment", kind: "audio", name: `${s.id}.wav`, mime: "audio/wav", sha256: createHash("sha256").update(s.wav).digest("hex"), bytes: s.wav }, { type: "text", text: s.question }] }],
    tools: [],
    cacheHints: [],
  };
  const run = await collectStream(adapter.stream({ context, setup, signal: AbortSignal.timeout(300_000) }));
  const base = { id: s.id, kind: s.kind, expected: s.expected, ms: Date.now() - t0 };
  if (run.error !== undefined) return { ...base, answer: "", right: false, error: run.error instanceof Error ? run.error.message : String(run.error) };
  const blocks = run.completed?.blocks ?? [];
  const answer = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const reasoning = blocks.flatMap((b) => (b.type === "reasoning" && typeof b.visible === "string" ? [b.visible] : [])).join("\n");
  const u = run.completed?.usage;
  return { ...base, answer, right: s.check(answer), stop: run.completed?.stop_reason, ...(u === undefined ? {} : { tokens: { in: u.input_tokens + (u.cache_read_tokens ?? 0), out: u.output_tokens, reasoning: u.reasoning_tokens } }), ...(reasoning === "" ? {} : { reasoning }), blocks: blocks.map((b) => b.type) };
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
