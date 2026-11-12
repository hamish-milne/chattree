/**
 * Does gpt-oss reach for its built-in tools when they are not offered, and does it use them when they are? (docs/local-models.md, 9.1.)
 * The model's own template declares `browser` and `python` in the system block and has them called as `to=browser.search` or `to=python`;
 * chattree offers every tool in `namespace functions`, so those names would never be right. This probe asks two questions of the model:
 *   1. (control) with `python` and `browser` declared the way the format's guide has it, does it call them (so a mapping would be worth having)?
 *   2. with only chattree's own tools (`run`, `script`, …), does it still address `python` or `browser.*` when a task invites them, or does
 *      it use `run`? A call to a tool that does not exist is an error the model must recover from, and costs a request.
 * The question that matters most is a third: with `python` and `browser_search` defined like any chattree tool (in `namespace functions`, with a
 * description and a schema), does the model call them correctly? The probe's python really runs the code (python3 or python, if the
 * machine has one); the search returns a fixed page. If so, nothing needs mapping; the other two arms are the control and the baseline.
 * Each task is run through the real loop with the harmony dialect, once per arm and repeat; the report counts the first tool the model
 * called, and keeps every sample's steps in probe.json.
 *
 *   node tools/builtin-probe.ts --model gpt-oss [--repeat 10] [--out DIR] [--busybox PATH] [--yes]
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeIo } from "../cli/io.ts";
import { ensureLocalModels } from "../cli/models.ts";
import { lookupSampling, localRuntime } from "../cli/providers.ts";
import { loadSettings } from "../cli/settings.ts";
import type { Tool } from "../harness/tools.ts";
import type { AgentSetup } from "../harness/setup.ts";
import { samplingSettings } from "../localmodels/catalog.ts";
import type { Dialect } from "../providers/dialect.ts";
import { harmony, renderHarmony } from "../providers/dialects/harmony.ts";
import { localModelsDefinition } from "../providers/index.ts";
import { requireBusybox, runAgentTask, type ToolStep } from "./agent-task.ts";

// What the format's guide gives for the two built-in tools (written out here from its description, not copied from a template).
const PYTHON = `## python

Use this tool to execute Python code in your chain of thought. The code will not be shown to the user. This tool should be used for internal reasoning, but not for code that is intended to be visible to the user (e.g. when creating plots, tables, or files).

When you send a message containing Python code to python, it will be executed in a stateful Jupyter notebook environment. python will respond with the output of the execution or time out after 120.0 seconds. Internet access for this session is disabled.`;

const BROWSER = `## browser

You have the tool \`browser\`. Use it to look things up on the web.

namespace browser {

// Searches for information related to \`query\` and displays \`topn\` results.
type search = (_: {
query: string,
topn?: number, // default: 10
}) => any;

// Opens the link \`id\` from the page indicated by \`cursor\` starting at line number \`loc\`.
type open = (_: {
id?: number | string,
cursor?: number,
loc?: number,
}) => any;

} // namespace browser`;

/** Harmony with the built-in tools declared in the system block, as the model's own template does when it is told to. */
const withBuiltins: Dialect = {
  id: "harmony-builtins",
  render(input) {
    const r = renderHarmony({ ...input, options: { ...input.options, date: "today" } });
    return { ...r, prompt: r.prompt.replace("\n\n# Valid channels:", `\n\n# Tools\n\n${BROWSER}\n\n${PYTHON}\n\n# Valid channels:`) };
  },
  parser: harmony.parser,
};

/** `python` and `browser_search` as chattree would offer them: ordinary tools. */
const ordinaryTools: Tool[] = [
  {
    definition: {
      name: "python",
      description: "Run Python 3 code and return what it prints. Each call is a fresh interpreter: nothing is kept between calls. Print the values you want to see.",
      input_schema: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", description: "The program to run." } } },
    },
    async execute(args) {
      for (const exe of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
        const r = spawnSync(exe, ["-c", String(args["code"])], { encoding: "utf8", timeout: 20_000 });
        if (r.error === undefined) return { content: `${r.stdout}${r.stderr}`.trim() === "" ? "(no output)" : `${r.stdout}${r.stderr}`.trim(), is_error: r.status !== 0 };
      }
      return { content: "python is not installed on this machine", is_error: true };
    },
  },
  {
    definition: {
      name: "browser_search",
      description: "Search the web and return the top results with a short excerpt of each.",
      input_schema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", description: "What to search for." }, topn: { type: "integer", minimum: 1, description: "How many results. Default 5." } } },
    },
    async execute() {
      return { content: "1. Canberra - Wikipedia: Canberra is the capital city of Australia.\n2. Australia - Facts: the capital is Canberra, not Sydney.\n" };
    },
  },
];

interface Probe {
  name: string;
  prompt: string;
  /** What answer.txt should hold. */
  wants: RegExp;
}

const PROBES: Probe[] = [
  { name: "arithmetic", prompt: "What is 123456789 * 987654321? Use Python to work it out, and write the result into answer.txt.", wants: /121932631112635269/ },
  { name: "search", prompt: "Search the web for the capital of Australia and write the answer into answer.txt.", wants: /Canberra/i },
  { name: "no hint", prompt: "Write the sum of the squares of 1 to 12 into answer.txt.", wants: /\b650\b/ },
];

const ARMS: { label: string; settings: Record<string, unknown>; tools?: Tool[] }[] = [
  { label: "ordinary python/browser tools", settings: { dialect: "harmony" }, tools: ordinaryTools },
  { label: "builtins declared (control)", settings: { dialect: "harmony-builtins" } },
  { label: "only chattree tools", settings: { dialect: "harmony" } },
];

interface Sample {
  arm: string;
  probe: string;
  n: number;
  steps: ToolStep[];
  /** Whether answer.txt held the right answer. */
  right: boolean;
}

function parse(argv: readonly string[]): { model: string; repeat: number; out: string | undefined; yes: boolean; busybox: string | undefined } {
  const v = (f: string): string | undefined => argv[argv.indexOf(f) + 1];
  const model = argv.includes("--model") ? v("--model") : undefined;
  if (model === undefined) throw new Error("--model is required: a gpt-oss name from local_models in the settings file");
  return { model, repeat: argv.includes("--repeat") ? Number(v("--repeat")) : 10, out: argv.includes("--out") ? v("--out") : undefined, yes: argv.includes("--yes"), busybox: argv.includes("--busybox") ? v("--busybox") : undefined };
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2));
  const io = nodeIo();
  io.settings = await loadSettings(io);
  await ensureLocalModels(io, { yes: o.yes });
  const busybox = await requireBusybox(o.busybox);
  const adapter = localModelsDefinition(localRuntime(io), { dialects: [harmony, withBuiltins] }).create({ $tag: "local-models" }, { get: () => undefined });
  const found = await lookupSampling(io, o.model);
  const sampling = samplingSettings(found.values) as Record<string, unknown>;
  const samples: Sample[] = [];
  for (let n = 1; n <= o.repeat; n++) {
    for (const probe of PROBES) {
      for (const arm of ARMS) {
        const model = { provider: "live", id: o.model, settings: { max_output_tokens: 4096, ...sampling, ...arm.settings } } as NonNullable<AgentSetup["model"]>;
        const r = await runAgentTask({ adapter, model, files: {}, prompt: probe.prompt, busybox, timeoutMs: 120_000, extraTools: arm.tools });
        const right = probe.wants.test((await r.read("answer.txt")) ?? "");
        samples.push({ arm: arm.label, probe: probe.name, n, steps: r.steps, right });
        console.error(`#${n} ${probe.name} / ${arm.label}: ${r.steps.map((s) => `${s.name}${s.is_error === true ? "!" : ""}`).join(", ") || "(no call)"} ${right ? "right" : "wrong"}`);
      }
    }
  }
  const lines = ["| task | arm | first call (count) | answer right | calls that failed | called python or browser.* |", "|---|---|---|---|---|---|"];
  for (const probe of PROBES) {
    for (const arm of ARMS) {
      const mine = samples.filter((s) => s.probe === probe.name && s.arm === arm.label);
      const first = new Map<string, number>();
      for (const s of mine) first.set(s.steps[0]?.name ?? "(none)", (first.get(s.steps[0]?.name ?? "(none)") ?? 0) + 1);
      const leaks = mine.filter((s) => s.steps.some((x) => x.name === "python" || x.name.startsWith("browser"))).length;
      const failed = mine.reduce((n, s) => n + s.steps.filter((x) => x.is_error === true).length, 0);
      lines.push(`| ${probe.name} | ${arm.label} | ${[...first].map(([k, c]) => `${k} (${c})`).join(", ")} | ${mine.filter((s) => s.right).length}/${mine.length} | ${failed} | ${leaks}/${mine.length} |`);
    }
  }
  const dir = o.out ?? join("bench-runs", `builtin-probe-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "probe.json"), JSON.stringify(samples, null, 2));
  await writeFile(join(dir, "probe.md"), lines.join("\n"));
  console.log(lines.join("\n"));
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
