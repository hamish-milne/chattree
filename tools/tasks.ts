/**
 * The agent tasks the live checks and the sampler share. Each is a prompt, the files the workspace starts with, and a
 * check of the outcome (not of the calls: a call that is valid but does the wrong thing is a failure). Tasks use only
 * programs every machine with Node and Git has, so they mean the same on Windows; `needs` marks the rest.
 */
import { spawnSync } from "node:child_process";
import type { AgentTaskResult } from "./agent-task.ts";

export interface Task {
  name: string;
  group: "edit" | "read" | "write" | "run" | "mixed";
  files: Record<string, string>;
  prompt: string;
  /** What is wrong with the outcome, or undefined when it is right. */
  check(r: AgentTaskResult): string | undefined | Promise<string | undefined>;
  /** Programs the task needs besides Node and Git; the sampler skips it when one is missing. */
  needs?: ("bash" | "posix")[];
}

const same = (r: AgentTaskResult, want: Record<string, string>): string | undefined => {
  for (const [f, text] of Object.entries(want)) if (r.after[f] !== text) return `${f} is ${JSON.stringify(r.after[f])}`;
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
    prompt: "In main.py add the line `import sys` right after `import os`, and add a final line `main()` at the end of the file.",
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
    prompt: "In calc.js make add return the sum of its arguments (remove the TODO comment). Leave sub alone.",
    check: (r) => same(r, { "calc.js": "function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n" }),
  },
];

export const TASKS: Task[] = [
  ...EDIT_TASKS,
  {
    name: "read two files",
    group: "read",
    files: { "a.txt": "the code word is PELICAN\n", "b.txt": "the number is 4417\n" },
    prompt: "What is the code word in a.txt and the number in b.txt? Answer with both.",
    check: (r) => (/PELICAN/.test(r.answer) && /4417/.test(r.answer) ? undefined : `the answer was ${JSON.stringify(r.answer.slice(0, 100))}`),
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
    name: "posix pipe",
    group: "run",
    needs: ["posix"],
    files: { "a.txt": "one\ntwo\nthree\n" },
    prompt: "Use the run tool to count the lines of a.txt with `cat a.txt | wc -l` and tell me the number.",
    check: (r) => (ranOk(r, "run") && /\b3\b/.test(r.answer) ? undefined : `answer ${JSON.stringify(r.answer.slice(0, 80))}`),
  },
  {
    name: "posix glob",
    group: "run",
    needs: ["posix"],
    files: { "a.txt": "1\n2\n", "b.txt": "1\n2\n3\n", "c.md": "x\n" },
    prompt: "Use the run tool to count the lines in every .txt file in this directory with `wc -l *.txt` and tell me the total.",
    check: (r) => (ranOk(r, "run") && /\b5\b/.test(r.answer) ? undefined : `answer ${JSON.stringify(r.answer.slice(0, 80))}`),
  },
  {
    name: "script loop",
    group: "run",
    needs: ["bash"],
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
export function available(need: "bash" | "posix"): boolean {
  if (need === "bash") return has("bash");
  return process.platform !== "win32" && has("sh");
}
