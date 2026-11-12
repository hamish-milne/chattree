/**
 * Does `builtin_tools` teach gpt-oss the convention over a chain of calls? (docs/local-models.md, 9.5.) The real harmony dialect with
 * `builtin_tools: {python, bash}`, a contrived task that needs five calls, alternating the two tools, and a count, for each call in order, of
 * whether the model wrote it exactly in the convention (`analysis to=NAME`, a bare message), in a way the dialect healed (another channel,
 * a `functions.` prefix, JSON with one key), or in a way that was refused with an error. If the convention takes, the later calls should be
 * exact; if the model drifts back, they will not.
 *
 *   node tools/builtin-chain.ts --model gpt-oss [--repeat 10] [--out DIR] [--busybox PATH] [--yes]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeIo } from "../cli/io.ts";
import { ensureLocalModels } from "../cli/models.ts";
import { localRuntime, lookupSampling } from "../cli/providers.ts";
import { loadSettings } from "../cli/settings.ts";
import type { AgentSetup } from "../harness/setup.ts";
import { samplingSettings } from "../localmodels/catalog.ts";
import type { Dialect } from "../providers/dialect.ts";
import { harmony } from "../providers/dialects/harmony.ts";
import { localModelsDefinition } from "../providers/index.ts";
import { requireBusybox, runAgentTask } from "./agent-task.ts";
import { callsIn, bashTool, pythonTool, setBusybox } from "./harmony-raw-probe.ts";

const FILES = { "data.csv": "name,amount\nann,12\nbob,7\ncyd,30\ndee,1\neve,50\nfay,9\n" };
const PROMPT = `Do these steps in order, using the python and bash tools as named, one tool call per step:
1. bash: count the lines in data.csv.
2. python: add up the amount column (the second column) of data.csv.
3. bash: append the line total=<the sum> to report.txt using echo.
4. python: read report.txt and print how many characters it has.
5. bash: cat report.txt.
Then write "lines=<step 1> total=<step 2> chars=<step 4>" into answer.txt and say you are done.`;

const raws: string[] = [];
const recording: Dialect = {
  ...harmony,
  id: "harmony-chain",
  parser(options, tools, prompt) {
    const inner = harmony.parser(options, tools, prompt);
    const i = raws.push("") - 1;
    return {
      push: (t) => {
        raws[i] += t;
        return inner.push(t);
      },
      end: (w) => inner.end(w),
    };
  },
};

type Kind = "exact" | "healed" | "refused";
interface Sample {
  n: number;
  right: boolean;
  requests: number;
  steps: { name: string; error: boolean }[];
  kinds: Kind[];
  /** The model's raw output, request by request. */
  raws: string[];
}

function args(argv: readonly string[]): { model: string; repeat: number; out: string | undefined; yes: boolean; busybox: string | undefined } {
  const v = (f: string): string | undefined => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const model = v("--model");
  if (model === undefined) throw new Error("--model is required: a gpt-oss name from local_models in the settings file");
  return { model, repeat: Number(v("--repeat") ?? 10), out: v("--out"), yes: argv.includes("--yes"), busybox: v("--busybox") };
}

async function main(): Promise<void> {
  const o = args(process.argv.slice(2));
  const io = nodeIo();
  io.settings = await loadSettings(io);
  await ensureLocalModels(io, { yes: o.yes });
  const busybox = await requireBusybox(o.busybox);
  setBusybox(busybox);
  const adapter = localModelsDefinition(localRuntime(io), { dialects: [harmony, recording] }).create({ $tag: "local-models" }, { get: () => undefined });
  const sampling = samplingSettings((await lookupSampling(io, o.model)).values) as Record<string, unknown>;
  const samples: Sample[] = [];
  for (let n = 1; n <= o.repeat; n++) {
    raws.length = 0;
    const model = { provider: "live", id: o.model, settings: { max_output_tokens: 4096, ...sampling, dialect: "harmony-chain", dialect_options: { builtin_tools: { python: true, bash: true } } } } as NonNullable<AgentSetup["model"]>;
    const r = await runAgentTask({ adapter, model, files: FILES, prompt: PROMPT, busybox, timeoutMs: 300_000, extraTools: [pythonTool, bashTool], without: ["run", "script"] });
    const answer = (await r.read("answer.txt")) ?? "";
    const right = /lines=7\b/.test(answer) && /total=109\b/.test(answer) && /chars=(9|10)\b/.test(answer);
    const tool = r.steps.filter((s) => s.name === "python" || s.name === "bash");
    const sent = [...raws].flatMap(callsIn).filter((m) => ["python", "bash"].includes((m.recipient ?? "").replace("functions.", "")));
    const kinds = tool.map((s, i): Kind => {
      const m = sent[i];
      if (s.result?.includes("was NOT run") === true) return "refused";
      return m !== undefined && m.channel === "analysis" && m.recipient === s.name && m.body === "bare" ? "exact" : "healed";
    });
    samples.push({ n, right, requests: r.requests, steps: r.steps.map((s) => ({ name: s.name, error: s.is_error === true })), kinds, raws: [...raws] });
    console.error(`#${n}: ${right ? "right" : "wrong"}, ${r.requests} requests, calls: ${tool.map((s, i) => `${s.name}:${kinds[i]}`).join(" ") || "(none)"}`);
  }
  const lines = [`Answers right: ${samples.filter((s) => s.right).length}/${samples.length}. Samples using each tool at least twice: python ${samples.filter((s) => s.steps.filter((x) => x.name === "python").length >= 2).length}, bash ${samples.filter((s) => s.steps.filter((x) => x.name === "bash").length >= 2).length}.`, "", "| nth built-in call | exact | healed | refused |", "|---|---|---|---|"];
  const longest = Math.max(0, ...samples.map((s) => s.kinds.length));
  for (let i = 0; i < longest; i++) {
    const at = samples.flatMap((s) => (s.kinds[i] === undefined ? [] : [s.kinds[i]]));
    lines.push(`| ${i + 1} | ${at.filter((k) => k === "exact").length} | ${at.filter((k) => k === "healed").length} | ${at.filter((k) => k === "refused").length} |`);
  }
  const dir = o.out ?? join("bench-runs", `builtin-chain-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "chain.json"), JSON.stringify(samples, null, 2));
  await writeFile(join(dir, "chain.md"), lines.join("\n"));
  console.log(lines.join("\n"));
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
