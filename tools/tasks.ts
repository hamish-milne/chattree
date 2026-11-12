/**
 * The agent tasks the live checks and the sampler share. Each is a prompt, the files the workspace starts with, and a
 * check of the outcome (not of the calls: a call that is valid but does the wrong thing is a failure). Tasks use only
 * programs every machine with Node and Git has, so they mean the same on Windows; `needs` marks the rest.
 */
import { spawnSync } from "node:child_process";
import type { AgentTaskResult } from "./agent-task.ts";

export interface Task {
  name: string;
  group: "edit" | "read" | "write" | "run" | "mixed" | "context";
  files: Record<string, string>;
  prompt: string;
  /** What is wrong with the outcome, or undefined when it is right. */
  check(r: AgentTaskResult): string | undefined | Promise<string | undefined>;
  /** What the task needs besides Node and Git (`utils`: cat, grep, wc, sh and friends, which Windows has through busybox); the sampler skips it when missing. */
  needs?: "utils"[];
  /** The model is told the date and where it is (the `environment` injection), as a session would; only tasks that depend on it say so. */
  environment?: true;
}

const noIndent = (t: string | undefined): string | undefined => t?.split("\n").map((l) => l.trim()).join("\n");
const same = (r: AgentTaskResult, want: Record<string, string>, ignoreIndent = false): string | undefined => {
  for (const [f, text] of Object.entries(want)) {
    const got = r.after[f];
    if (ignoreIndent ? noIndent(got) !== noIndent(text) : got !== text) return `${f} is ${JSON.stringify(got)}`;
  }
  return undefined;
};
const ranOk = (r: AgentTaskResult, tool: string): boolean => r.steps.some((s) => s.name === tool && s.is_error === false);

export const EDIT_TASKS: Task[] = [
  { name: "one line", group: "edit", files: { "notes.txt": "status: draft\n" }, prompt: "In notes.txt change the word draft to final.", check: (r) => same(r, { "notes.txt": "status: final\n" }) },
  {
    name: "two places",
    group: "edit",
    files: { "app.conf": "name = demo\nretries = 3\nverbose = false\ntimeout = 10\n" },
    prompt: "In app.conf set retries to 5 and verbose to true. Change nothing else.",
    check: (r) => same(r, { "app.conf": "name = demo\nretries = 5\nverbose = true\ntimeout = 10\n" }),
  },
  {
    name: "delete a block",
    group: "edit",
    files: { "list.txt": "keep 1\ndrop a\ndrop b\ndrop c\nkeep 2\nkeep 3\n" },
    prompt: "Remove the three lines that start with `drop` from list.txt.",
    check: (r) => same(r, { "list.txt": "keep 1\nkeep 2\nkeep 3\n" }),
  },
  {
    name: "insert and append",
    group: "edit",
    files: { "main.py": "import os\n\ndef main():\n    print('hi')\n" },
    prompt: "In main.py add the line `import sys` right after `import os` without removing any existing line (the blank line stays), and add a final line `main()` directly after the last line (no blank line before it).",
    check: (r) => same(r, { "main.py": "import os\nimport sys\n\ndef main():\n    print('hi')\nmain()\n" }),
  },
  {
    name: "edit after edit",
    group: "edit",
    files: { "f.txt": "alpha\nbeta\ngamma\n" },
    prompt: "In f.txt first insert the line `# v2` at the top. Once that is done, change the line `gamma` to `GAMMA`.",
    check: (r) => same(r, { "f.txt": "# v2\nalpha\nbeta\nGAMMA\n" }),
  },
  {
    name: "replace a function body",
    group: "edit",
    files: { "calc.js": "function add(a, b) {\n  // TODO\n  return 0;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n" },
    prompt: "In calc.js make add return `a + b` (remove the TODO comment). Leave sub alone.",
    // Indentation is the model's choice, not the tool's: compare lines without it.
    check: (r) => same(r, { "calc.js": "function add(a, b) {\nreturn a + b;\n}\n\nfunction sub(a, b) {\nreturn a - b;\n}\n" }, true),
  },
];

export const TASKS: Task[] = [
  ...EDIT_TASKS,
  {
    name: "read two files",
    group: "read",
    files: { "a.txt": "the code word is WALRUS\n", "b.txt": "the number is 4417\n" },
    prompt: "What is the code word in a.txt and the number in b.txt? Answer with both.",
    check: (r) => (/WALRUS/.test(r.answer) && /4417/.test(r.answer) ? undefined : `the answer was ${JSON.stringify(r.answer.slice(0, 100))}`),
  },
  {
    name: "read a window",
    group: "read",
    files: { "long.txt": Array.from({ length: 300 }, (_, i) => (i === 249 ? "line 250 says MARMOT" : `line ${i + 1}`)).join("\n") + "\n" },
    prompt: "What does line 250 of long.txt say? Do not read more of the file than you need.",
    check: (r) => (/MARMOT/.test(r.answer) ? undefined : `the answer was ${JSON.stringify(r.answer.slice(0, 100))}`),
  },
  {
    name: "write a new file",
    group: "write",
    files: { "seed.txt": "x\n" },
    prompt: "Create the file docs/greeting.txt containing exactly: hello world",
    check: async (r) => {
      const t = await r.read("docs/greeting.txt");
      return t?.trimEnd() === "hello world" ? undefined : `docs/greeting.txt is ${JSON.stringify(t)}`;
    },
  },
  {
    // Several calls in one turn: a model that writes one call and then its end-of-turn marker, or drops the separator between calls, fails here.
    name: "three files at once",
    group: "write",
    files: { "seed.txt": "x\n" },
    prompt: "Create three files: a.txt containing exactly `alpha`, b.txt containing exactly `beta`, and c.txt containing exactly `gamma`. Make the three write calls together, in one turn.",
    check: async (r) => {
      for (const [f, want] of [["a.txt", "alpha"], ["b.txt", "beta"], ["c.txt", "gamma"]] as const) {
        const t = await r.read(f);
        if (t?.trim() !== want) return `${f} is ${JSON.stringify(t)}`;
      }
      return undefined;
    },
  },
  {
    // The answer is mostly the text of the file just read, which is what n-gram speculation drafts from.
    name: "copy with a rename",
    group: "write",
    files: { "util.py": "import json\n\n\ndef load_records(path):\n    with open(path) as f:\n        return [json.loads(line) for line in f if line.strip()]\n\n\ndef total_by_name(records):\n    totals = {}\n    for r in records:\n        totals[r[\"name\"]] = totals.get(r[\"name\"], 0) + r[\"amount\"]\n    return totals\n\n\ndef main():\n    print(total_by_name(load_records(\"data.jsonl\")))\n" },
    prompt: "Read util.py, then create util2.py with the same content, except that the function total_by_name is renamed sum_by_name everywhere. Leave util.py as it is.",
    check: async (r) => {
      const t = await r.read("util2.py");
      if (t === undefined) return "util2.py was not created";
      if (/total_by_name/.test(t) || (t.match(/sum_by_name/g) ?? []).length !== 2) return `util2.py is ${JSON.stringify(t.slice(0, 200))}`;
      return t.replaceAll("sum_by_name", "total_by_name").trimEnd() === (r.after["util.py"] ?? "").trimEnd() ? undefined : "util2.py differs from util.py in more than the name";
    },
  },
  {
    name: "run a program",
    group: "run",
    files: {},
    prompt: "Run `node --version` with the run tool and tell me what it prints.",
    check: (r) => (ranOk(r, "run") && /v\d+\.\d+/.test(r.answer) ? undefined : ranOk(r, "run") ? `the answer was ${JSON.stringify(r.answer.slice(0, 100))}` : "no successful run call"),
  },
  {
    name: "run with redirect",
    group: "run",
    files: {},
    prompt: "Use the run tool to run `node --version` and save its output to the file version.txt (not by writing the file yourself).",
    check: async (r) => {
      const t = await r.read("version.txt");
      return ranOk(r, "run") && /^v\d+\.\d+/.test(t ?? "") ? undefined : `version.txt is ${JSON.stringify(t)}, run succeeded: ${ranOk(r, "run")}`;
    },
  },
  {
    name: "run with pipe",
    group: "run",
    files: { "words.txt": "pear\napple\nfig\n" },
    prompt: "Use one run call to run `node -p \"require('fs').readFileSync('words.txt','utf8')\"` and pipe its output into `node -e \"process.stdin.on('data',d=>process.stdout.write(String(d).toUpperCase()))\"`, then tell me what came out.",
    check: (r) => (ranOk(r, "run") && /PEAR/.test(r.answer) && /APPLE/.test(r.answer) ? undefined : `the answer was ${JSON.stringify(r.answer.slice(0, 100))}, run succeeded: ${ranOk(r, "run")}`),
  },
  {
    name: "run git",
    group: "run",
    files: { "untracked.txt": "hello\n" },
    prompt: "Use the run tool to run `git log --oneline` and tell me how many lines it printed.",
    check: (r) => (ranOk(r, "run") && /\d/.test(r.answer) ? undefined : `run succeeded: ${ranOk(r, "run")}, answer ${JSON.stringify(r.answer.slice(0, 80))}`),
  },
  {
    name: "utility pipe",
    group: "run",
    needs: ["utils"],
    files: { "a.txt": "one\ntwo\nthree\n" },
    prompt: "Use the run tool to count the lines of a.txt with `cat a.txt | wc -l` and tell me the number.",
    check: (r) => (ranOk(r, "run") && /\b3\b/.test(r.answer) ? undefined : `answer ${JSON.stringify(r.answer.slice(0, 80))}`),
  },
  {
    name: "utility glob",
    group: "run",
    needs: ["utils"],
    files: { "a.txt": "1\n2\n", "b.txt": "1\n2\n3\n", "c.md": "x\n" },
    prompt: "Use the run tool to count the lines in every .txt file in this directory with `wc -l *.txt` and tell me the number on the `total` line.",
    check: (r) => (ranOk(r, "run") && /\b5\b/.test(r.answer) ? undefined : `answer ${JSON.stringify(r.answer.slice(0, 80))}`),
  },
  {
    name: "script loop",
    group: "run",
    needs: ["utils"],
    files: {},
    prompt: "Use the script tool to write the numbers 1 to 3, one per line, into nums.txt with a shell for loop.",
    check: async (r) => {
      const t = await r.read("nums.txt");
      return t?.trim().split(/\r?\n/).join(",") === "1,2,3" ? undefined : `nums.txt is ${JSON.stringify(t)}`;
    },
  },
  {
    name: "edit then run",
    group: "mixed",
    files: { "notes.txt": "status: draft\n" },
    prompt: "Read notes.txt, then use the edit tool to change the word draft to final, then use the run tool to run `git log --oneline -n 3` and tell me how many lines it printed.",
    check: (r) => (r.after["notes.txt"] === "status: final\n" && ranOk(r, "run") && r.status === "completed" ? undefined : `notes.txt is ${JSON.stringify(r.after["notes.txt"])}, run succeeded: ${ranOk(r, "run")}, status ${r.status}`),
  },
];

const has = (program: string): boolean => spawnSync(program, ["-c", "true"], { stdio: "ignore" }).status === 0;
/** Whether the machine can run a task's extra requirements. */
export function available(need: "utils", busybox: string | undefined): boolean {
  void need;
  return process.platform === "win32" ? busybox !== undefined : has("sh");
}

/**
 * Tasks that test what a dialect tells the model rather than how it calls tools (docs/local-models.md, section 9). They are not in `TASKS`:
 * ask for them with `--group context`. They need a model's own thinking to vary with its settings, so compare arms by output tokens too.
 */
const monthAfter = (days: number): string => new Date(Date.now() + days * 86_400_000).toLocaleString("en-US", { month: "long" });
export const CONTEXT_TASKS: Task[] = [
  {
    name: "month in a week",
    group: "context",
    environment: true,
    files: {},
    prompt: "Write the name of the month it will be one week from today into month.txt (just the name).",
    check: async (r) => {
      const t = (await r.read("month.txt"))?.trim();
      return t?.toLowerCase() === monthAfter(7).toLowerCase() ? undefined : `month.txt is ${JSON.stringify(t)}, wanted ${monthAfter(7)}`;
    },
  },
  {
    name: "riddle with a twist",
    group: "context",
    files: {},
    prompt: "A farmer has 17 sheep. All but 9 die, and then he buys 3 more. Write how many sheep he has now into answer.txt (just the number).",
    check: async (r) => {
      const t = (await r.read("answer.txt"))?.trim();
      return t === "12" ? undefined : `answer.txt is ${JSON.stringify(t)}, wanted 12`;
    },
  },
];
