/**
 * Can a local model see? Pictures made on the fly (tools/vision-scenarios.ts: shapes and colours, counts, positions, words, numbers,
 * sums) go to the model one at a time, each with its question, and the answers are checked. Shapes and counts use the model's picture
 * reading and words, numbers and sums its text reading, so the table says which of the two a model (and its projector) is weaker at.
 * The pictures are written next to the results, so a wrong answer can be looked at.
 *
 *   node tools/vision-probe.ts --model NAME [--count 5] [--seed 1] [--kinds shape,text] [--dialect NAME] [--as webp|tiff|bmp|jpeg|gif|png] [--max-tokens 1024] [--out DIR] [--yes]
 *
 * `--model` is a name from local_models in the settings file, with its `mmproj` set (a projector file next to the model, or `auto`).
 * `--as FORMAT` (webp, tiff, bmp, jpeg, gif, png) makes each picture into that format first and sends it through the same step a request goes through
 * (the sink's media spec and ffmpeg), so the run tests the conversion as well as the model; the result says what the model was sent. It needs the `ffmpeg` setting.
 * `--dialect NAME` sends the picture through that dialect's `/completion` (kimi-vl, qwen-xml, gemma, ...) and not the chat endpoint.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeIo } from "../cli/io.ts";
import { ensureLocalModels } from "../cli/models.ts";
import { lookupSampling } from "../cli/providers.ts";
import { loadSettings } from "../cli/settings.ts";
import type { ModelContext } from "../harness/context-builder.ts";
import { emptySetup, type AgentSetup } from "../harness/setup.ts";
import { samplingSettings } from "../localmodels/catalog.ts";
import { collectStream } from "../providers/conformance.ts";
import { localModelsAdapter } from "./local-adapter.ts";
import { SOURCE_FORMATS, probeFfmpeg, reencode, throughSink } from "./media-source.ts";
import { KINDS, scenarios, type Kind, type Scenario } from "./vision-scenarios.ts";
import { createHash } from "node:crypto";

export interface Result {
  id: string;
  kind: Kind;
  expected: string;
  answer: string;
  right: boolean;
  error?: string;
  ms: number;
  /** With `--as`: what the picture was made into, and what the request sent after conversion. */
  sent?: string;
  /** Why the request ended (`end_turn`, `max_tokens`, ...), and its tokens, so an empty answer can be told from a cut-off one. */
  stop?: string | undefined;
  tokens?: { in: number; out: number; reasoning?: number | undefined };
  /** The reasoning the model wrote, when there was any: what it said it saw. */
  reasoning?: string | undefined;
  /** The kinds of block that came back, in order. */
  blocks?: string[];
}

function args(argv: readonly string[]) {
  const v = (f: string): string | undefined => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const model = v("--model");
  if (model === undefined) throw new Error("--model is required: a model from local_models in the settings file, with an mmproj");
  const kinds = v("--kinds")
    ?.split(",")
    .map((k) => k.trim());
  for (const k of kinds ?? [])
    if (!(KINDS as readonly string[]).includes(k)) throw new Error(`--kinds: ${k} is not one of ${KINDS.join(", ")}`);
  return {
    model,
    count: Number(v("--count") ?? 5),
    seed: Number(v("--seed") ?? 1),
    kinds: kinds as Kind[] | undefined,
    maxTokens: Number(v("--max-tokens") ?? 1024),
    dialect: v("--dialect"),
    as: v("--as"),
    out: v("--out"),
    yes: argv.includes("--yes"),
  };
}

/** The table of results: right of total for each kind, and the wrong answers. */
export function report(results: readonly Result[]): string {
  const lines = ["| kind | right | of |", "|---|---|---|"];
  for (const k of KINDS) {
    const rs = results.filter((r) => r.kind === k);
    if (rs.length > 0) lines.push(`| ${k} | ${rs.filter((r) => r.right).length} | ${rs.length} |`);
  }
  lines.push(`| all | ${results.filter((r) => r.right).length} | ${results.length} |`);
  const wrong = results.filter((r) => !r.right);
  if (wrong.length > 0) {
    lines.push("", "Wrong:", "");
    for (const r of wrong)
      lines.push(
        `- ${r.id}: expected ${r.expected}; ${r.error !== undefined ? `error: ${r.error}` : `answered ${JSON.stringify(r.answer.slice(0, 200))}`}${r.stop === undefined || r.stop === "end_turn" ? "" : ` [${r.stop}]`}${r.tokens === undefined ? "" : ` (${r.tokens.out} tokens out)`}`,
      );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const o = args(process.argv.slice(2));
  const io = nodeIo();
  io.settings = await loadSettings(io);
  await ensureLocalModels(io, { yes: o.yes });
  const adapter = localModelsAdapter(io);
  const sampling = samplingSettings((await lookupSampling(io, o.model)).values) as Record<string, unknown>;
  const model = {
    provider: "live",
    id: o.model,
    settings: { max_output_tokens: o.maxTokens, ...sampling, ...(o.dialect === undefined ? {} : { dialect: o.dialect }) },
  } as NonNullable<AgentSetup["model"]>;
  const setup: AgentSetup = { ...emptySetup(), model };
  const dir = o.out ?? join("bench-runs", `vision-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  await mkdir(dir, { recursive: true });
  const results: Result[] = [];
  if (o.as !== undefined && SOURCE_FORMATS[o.as]?.mime.startsWith("image/") !== true)
    throw new Error(
      `--as: ${o.as} is not a picture format (${Object.entries(SOURCE_FORMATS)
        .filter(([, f]) => f.mime.startsWith("image/"))
        .map(([k]) => k)
        .join(", ")})`,
    );
  const via = o.as === undefined ? undefined : { as: o.as, ffmpeg: await probeFfmpeg(io), workDir: join(dir, "work") };
  for (const s of scenarios({ kinds: o.kinds, count: o.count, seed: o.seed })) {
    await writeFile(join(dir, `${s.id}.png`), s.png);
    results.push(await ask(adapter, setup, s, via));
    const r = results[results.length - 1] as Result;
    console.error(
      `${r.id}: ${r.right ? "right" : "wrong"} (${r.ms} ms) ${r.right ? "" : `expected ${r.expected}, got ${JSON.stringify(r.answer.slice(0, 80))}${r.error === undefined ? "" : ` ${r.error}`}`}`,
    );
  }
  const text = report(results);
  await writeFile(join(dir, "vision.json"), JSON.stringify(results, null, 2));
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({ model: o.model, dialect: o.dialect, maxTokens: o.maxTokens, seed: o.seed, sampling }, null, 2),
  );
  await writeFile(join(dir, "vision.md"), text);
  console.log(text);
}

async function ask(
  adapter: ReturnType<typeof localModelsAdapter>,
  setup: AgentSetup,
  s: Scenario,
  via?: { as: string; ffmpeg: string; workDir: string },
): Promise<Result> {
  const t0 = Date.now();
  const made = via === undefined ? { bytes: s.png, mime: "image/png", ext: "png" } : await reencode(via.ffmpeg, s.png, "png", via.as);
  let context: ModelContext = {
    system: "You are terse. Answer only what is asked.",
    instructions: undefined,
    turns: [
      {
        role: "user",
        parts: [
          {
            type: "attachment",
            kind: "image",
            name: `${s.id}.${made.ext}`,
            mime: made.mime,
            sha256: createHash("sha256").update(made.bytes).digest("hex"),
            bytes: made.bytes,
          },
          { type: "text", text: s.question },
        ],
      },
    ],
    tools: [],
    cacheHints: [],
  };
  let sent: string | undefined;
  const base = {
    id: s.id,
    kind: s.kind,
    expected: s.expected,
    get ms() {
      return Date.now() - t0;
    },
  };
  if (via !== undefined) {
    const prepared = await throughSink(adapter, setup, context, via.ffmpeg, via.workDir);
    if (prepared.warnings.length > 0)
      return {
        ...base,
        answer: "",
        right: false,
        error: prepared.warnings.map((w) => w.message).join("; "),
        sent: `${made.mime} (not sent)`,
      };
    context = prepared.context;
    sent = `${made.mime} -> ${prepared.converted.map((c) => c.to).join(", ") || "as it was"}`;
  }
  const run = await collectStream(adapter.stream({ context, setup, signal: AbortSignal.timeout(300_000) }));
  if (run.error !== undefined)
    return {
      ...base,
      ...(sent === undefined ? {} : { sent }),
      answer: "",
      right: false,
      error: run.error instanceof Error ? run.error.message : String(run.error),
    };
  const blocks = run.completed?.blocks ?? [];
  const answer = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const reasoning = blocks.flatMap((b) => (b.type === "reasoning" && typeof b.visible === "string" ? [b.visible] : [])).join("\n");
  const u = run.completed?.usage;
  return {
    ...base,
    ...(sent === undefined ? {} : { sent }),
    answer,
    right: s.check(answer),
    stop: run.completed?.stop_reason,
    ...(u === undefined
      ? {}
      : { tokens: { in: u.input_tokens + (u.cache_read_tokens ?? 0), out: u.output_tokens, reasoning: u.reasoning_tokens } }),
    ...(reasoning === "" ? {} : { reasoning }),
    blocks: blocks.map((b) => b.type),
  };
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
