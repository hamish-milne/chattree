/**
 * How does gpt-oss call a built-in tool, and what does it do with a tool of our own that is described the same way? (docs/local-models.md, 9.5.)
 * The model was trained on `python` and `browser` as built-ins: described in prose in the system block (no schema), called on the `analysis`
 * channel as `to=python`, with the code as the bare message. Functions are declared in the developer block as TypeScript and called on
 * `commentary` as `to=functions.NAME <|constrain|>json` with a JSON body. This probe asks, from the model's raw output (the first request of
 * each sample and every later one):
 *   - given `python` as a built-in, does it always call `analysis to=python`, and is the body always bare (never JSON)?
 *   - given a built-in of our own (`bash`), described the same way, does it use it in the same manner?
 *   - given the tool as a function whose argument is declared as a string (`_: string`), or as the usual object, what does it send?
 * `run` and `script` are not offered, so the shell and Python can only be reached through the tools under test. Nothing here is part of chattree's dialects: the probe's own dialect renders the built-ins (and writes earlier calls to them the same
 * way, which is a guess at the format, so judge the first request of each sample first).
 *
 *   node tools/harmony-raw-probe.ts --model gpt-oss [--repeat 10] [--out DIR] [--busybox PATH] [--yes]
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeIo } from "../cli/io.ts";
import { ensureLocalModels } from "../cli/models.ts";
import { localRuntime, lookupSampling } from "../cli/providers.ts";
import { loadSettings } from "../cli/settings.ts";
import type { Tool } from "../harness/tools.ts";
import type { AgentSetup } from "../harness/setup.ts";
import { samplingSettings } from "../localmodels/catalog.ts";
import type { Dialect } from "../providers/dialect.ts";
import { harmony, renderHarmony } from "../providers/dialects/harmony.ts";
import { localModelsDefinition } from "../providers/index.ts";
import { requireBusybox, runAgentTask } from "./agent-task.ts";
import { ordinaryTools, PYTHON } from "./builtin-probe.ts";

// `bash` described the way `python` is: prose only, no schema, no word about JSON. (Our own wording, in the style of the python text.)
const BASH = `## bash

Use this tool to run shell commands. When you send a message containing a shell command to bash, it will be executed in the workspace directory, and bash will respond with the command's output or time out after 60.0 seconds.`;

const PROSE: Record<string, string> = { python: PYTHON, bash: BASH };

const pythonTool = ordinaryTools[0] as Tool;

let busybox: string | undefined;
const bashTool: Tool = {
  definition: {
    name: "bash",
    description: "Run a shell command in the workspace and return its output.",
    input_schema: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string", description: "The command line." } } },
  },
  async execute(args, ctx) {
    const [exe, ...pre] = busybox === undefined ? ["sh"] : [busybox, "sh"];
    const r = spawnSync(exe as string, [...pre, "-c", String(args["command"])], { cwd: ctx.workspace, encoding: "utf8", timeout: 60_000 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    return { content: out === "" ? "(no output)" : out, is_error: r.status !== 0 };
  },
};

/** The single string value of a JSON body, else the body as it is. */
const bare = (body: string): string => {
  try {
    const v = JSON.parse(body) as unknown;
    if (typeof v === "object" && v !== null) {
      const vals = Object.values(v);
      if (vals.length === 1 && typeof vals[0] === "string") return vals[0];
    }
  } catch {
    /* not JSON: already bare */
  }
  return body;
};

/** Raw output of each request, in order; the parser below fills it. */
const raws: string[] = [];

export const probeDialect: Dialect = {
  id: "harmony-probe",
  render(input) {
    const builtins = Object.keys((input.options["builtins"] ?? {}) as Record<string, unknown>);
    const strings = (input.options["strings"] ?? []) as string[];
    const visible = input.context.tools.filter((t) => !builtins.includes(t.name));
    let { prompt, stop } = renderHarmony({ ...input, context: { ...input.context, tools: visible }, options: {} });
    if (builtins.length > 0) prompt = prompt.replace("\n\n# Valid channels:", `\n\n# Tools\n\n${builtins.map((b) => PROSE[b]).join("\n\n")}\n\n# Valid channels:`);
    for (const b of builtins) {
      // An earlier call to a built-in: on analysis, to=NAME, the code bare; its result from NAME on analysis (a guess at the format).
      prompt = prompt
        .replace(new RegExp(`<\\|start\\|>assistant<\\|channel\\|>commentary to=functions\\.${b} <\\|constrain\\|>json<\\|message\\|>([\\s\\S]*?)<\\|call\\|>`, "g"), (_m, body: string) => `<|start|>assistant<|channel|>analysis to=${b}<|message|>${bare(body)}<|call|>`)
        .replaceAll(`<|start|>functions.${b} to=assistant<|channel|>commentary<|message|>`, `<|start|>${b} to=assistant<|channel|>analysis<|message|>`);
    }
    for (const s of strings) {
      prompt = prompt
        .replace(new RegExp(`type ${s} = \\(_: \\{[\\s\\S]*?\\n\\}\\) => any;`), `type ${s} = (_: string) => any;`)
        .replace(new RegExp(`(to=functions\\.${s} <\\|constrain\\|>json<\\|message\\|>)([\\s\\S]*?)(<\\|call\\|>)`, "g"), (_m, a: string, body: string, c: string) => `${a}${bare(body)}${c}`);
    }
    return { prompt, stop };
  },
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

interface Task {
  name: string;
  prompt: string;
  files: Record<string, string>;
  wants: RegExp;
}

const TASKS: Record<string, Task> = {
  python: { name: "python arithmetic", prompt: "What is 123456789 * 987654321? Use Python to work it out, and write the result into answer.txt.", files: {}, wants: /121932631112635269/ },
  bash: { name: "bash line count", prompt: "Use bash to count the lines in notes.txt, and write the number into answer.txt.", files: { "notes.txt": "a\nb\nc\nd\ne\nf\ng\n" }, wants: /\b7\b/ },
};

interface Arm {
  label: string;
  options: Record<string, unknown>;
  tools: Tool[];
  tasks: string[];
}

const ARMS: Arm[] = [
  { label: "python as built-in", options: { builtins: { python: true } }, tools: [pythonTool], tasks: ["python"] },
  { label: "bash as built-in (ours)", options: { builtins: { bash: true } }, tools: [bashTool], tasks: ["bash"] },
  { label: "python and bash as built-ins", options: { builtins: { python: true, bash: true } }, tools: [pythonTool, bashTool], tasks: ["python", "bash"] },
  { label: "python as function, string argument", options: { strings: ["python"] }, tools: [pythonTool], tasks: ["python"] },
  { label: "python as function, object argument", options: {}, tools: [pythonTool], tasks: ["python"] },
  { label: "bash as function, string argument", options: { strings: ["bash"] }, tools: [bashTool], tasks: ["bash"] },
  { label: "bash as function, object argument", options: {}, tools: [bashTool], tasks: ["bash"] },
];

export interface Message {
  channel: string;
  recipient: string | undefined;
  constrain: string | undefined;
  /** What stood between the recipient and `<|message|>` besides the constrain token (the guide's python calls may have a word there). */
  tail: string;
  body: "json object" | "other json" | "bare";
}

/** The messages in one request's raw output that went to a recipient. */
export function callsIn(raw: string): Message[] {
  const out: Message[] = [];
  const re = /<\|channel\|>(\w+)([^<]*?)(?:<\|constrain\|>(\w+))?<\|message\|>([\s\S]*?)(?:<\|call\|>|<\|end\|>|<\|return\|>|$)/g;
  for (const m of raw.matchAll(re)) {
    const head = m[2] as string;
    const to = /\bto=(\S+)/.exec(head)?.[1];
    if (to === undefined) continue;
    const tail = head.replace(/\bto=\S+/, "").trim();
    const body = (m[4] as string).trim();
    let kind: Message["body"] = "bare";
    try {
      const v = JSON.parse(body) as unknown;
      kind = typeof v === "object" && v !== null && !Array.isArray(v) ? "json object" : "other json";
    } catch {
      /* bare */
    }
    out.push({ channel: m[1] as string, recipient: to, constrain: m[3], tail, body: kind });
  }
  return out;
}

interface Sample {
  arm: string;
  task: string;
  n: number;
  right: boolean;
  steps: string[];
  raws: string[];
  calls: Message[];
}

function args(argv: readonly string[]): { model: string; repeat: number; out: string | undefined; yes: boolean; busybox: string | undefined } {
  const v = (f: string): string | undefined => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const model = v("--model");
  if (model === undefined) throw new Error("--model is required: a gpt-oss name from local_models in the settings file");
  return { model, repeat: Number(v("--repeat") ?? 10), out: v("--out"), yes: argv.includes("--yes"), busybox: v("--busybox") };
}

const tally = (xs: (string | undefined)[]): string => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x ?? "-", (m.get(x ?? "-") ?? 0) + 1);
  return [...m].map(([k, c]) => `${k} (${c})`).join(", ") || "-";
};

async function main(): Promise<void> {
  const o = args(process.argv.slice(2));
  const io = nodeIo();
  io.settings = await loadSettings(io);
  await ensureLocalModels(io, { yes: o.yes });
  busybox = await requireBusybox(o.busybox);
  const adapter = localModelsDefinition(localRuntime(io), { dialects: [harmony, probeDialect] }).create({ $tag: "local-models" }, { get: () => undefined });
  const sampling = samplingSettings((await lookupSampling(io, o.model)).values) as Record<string, unknown>;
  const samples: Sample[] = [];
  for (let n = 1; n <= o.repeat; n++) {
    for (const arm of ARMS) {
      for (const key of arm.tasks) {
        const task = TASKS[key] as Task;
        raws.length = 0;
        const model = { provider: "live", id: o.model, settings: { max_output_tokens: 4096, ...sampling, dialect: "harmony-probe", dialect_options: arm.options } } as NonNullable<AgentSetup["model"]>;
        const r = await runAgentTask({ adapter, model, files: task.files, prompt: task.prompt, busybox, timeoutMs: 120_000, extraTools: arm.tools, without: ["run", "script"] });
        const right = task.wants.test((await r.read("answer.txt")) ?? "");
        const mine = [...raws];
        samples.push({ arm: arm.label, task: task.name, n, right, steps: r.steps.map((s) => `${s.name}${s.is_error === true ? "!" : ""}`), raws: mine, calls: mine.flatMap(callsIn) });
        console.error(`#${n} ${arm.label} / ${task.name}: ${samples.at(-1)?.steps.join(", ") || "(no call)"} ${right ? "right" : "wrong"}`);
      }
    }
  }
  const lines = ["| arm | task | right | first call: channel, recipient | constrain | word before message | body (JSON object / bare) | other tools used |", "|---|---|---|---|---|---|---|---|"];
  for (const arm of ARMS) {
    for (const key of arm.tasks) {
      const task = TASKS[key] as Task;
      const mine = samples.filter((s) => s.arm === arm.label && s.task === task.name);
      const tools = ["python", "bash"].filter((t) => arm.tools.some((x) => x.definition.name === t));
      const mineCalls = mine.flatMap((s) => s.calls.filter((c) => tools.some((t) => c.recipient === t || c.recipient === `functions.${t}`)));
      const first = mine.map((s) => s.calls[0]);
      const others = mine.flatMap((s) => s.steps.map((x) => x.replace("!", "")).filter((x) => !tools.includes(x) && x !== "write"));
      lines.push(`| ${arm.label} | ${task.name} | ${mine.filter((s) => s.right).length}/${mine.length} | ${tally(first.map((c) => (c === undefined ? undefined : `${c.channel} ${c.recipient}`)))} | ${tally(mineCalls.map((c) => c.constrain))} | ${tally(mineCalls.map((c) => (c.tail === "" ? undefined : c.tail)))} | ${tally(mineCalls.map((c) => c.body))} | ${tally(others)} |`);
    }
  }
  const dir = o.out ?? join("bench-runs", `harmony-raw-probe-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
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
