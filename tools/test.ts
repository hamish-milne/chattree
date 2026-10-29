/**
 * The test groups, as one portable command (an env var in a package.json script does not work on Windows):
 *   node tools/test.ts          the quick group (what `pnpm test` runs)
 *   node tools/test.ts slow     only the [slow] suites (see test/support/slow.ts)
 *   node tools/test.ts all      both
 *   node tools/test.ts quick test/cli/chat.test.ts ...   only these files
 *
 * Each test file runs in its own node process, a few at a time, with a time limit. A file that hangs (a child process that does not
 * end, a prompt nobody answers) is killed with its process tree and reported by name instead of stalling the whole run for hours.
 */
import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

const group = process.argv[2] ?? "quick";
if (!["quick", "slow", "all"].includes(group)) {
  console.error("usage: node tools/test.ts [quick|slow|all] [files...]");
  process.exit(2);
}

function find(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...find(p));
    else if (e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const files = (process.argv.length > 3 ? process.argv.slice(3) : find("test")).sort();
const fileLimitMs = Number(process.env["CHATTREE_FILE_TIMEOUT_MS"] ?? 8 * 60_000);
const testTimeoutMs = Number(process.env["CHATTREE_TEST_TIMEOUT_MS"] ?? 3 * 60_000);
const jobs = Math.max(1, Math.min(Number(process.env["CHATTREE_TEST_JOBS"] ?? 3), availableParallelism()));
const env = { ...process.env, ...(group === "quick" ? {} : { CHATTREE_SLOW: "1" }) };

function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

interface Result {
  file: string;
  ok: boolean;
  timedOut: boolean;
  seconds: number;
  output: string;
}

function runFile(file: string): Promise<Result> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = ["--no-warnings", "--test", `--test-timeout=${testTimeoutMs}`, "--test-force-exit", ...(group === "slow" ? ["--test-name-pattern=\\[slow\\]"] : []), file];
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = "";
    child.stdout.on("data", (d: Buffer) => void (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => void (output += d.toString()));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, fileLimitMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0 && !timedOut, timedOut, seconds: (Date.now() - t0) / 1000, output });
    });
  });
}

const queue = [...files];
const results: Result[] = [];
async function worker(): Promise<void> {
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    console.log(`start  ${file}`);
    const r = await runFile(file);
    results.push(r);
    console.log(`${r.ok ? "ok    " : r.timedOut ? "HUNG  " : "FAILED"} ${file} (${r.seconds.toFixed(1)}s)`);
    if (!r.ok) console.log(r.output.split("\n").map((l) => `    ${l}`).join("\n"));
  }
}
await Promise.all(Array.from({ length: jobs }, worker));

const bad = results.filter((r) => !r.ok);
const slowest = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 5);
console.log(`\n${results.length - bad.length}/${results.length} files passed. Slowest: ${slowest.map((r) => `${r.file} ${r.seconds.toFixed(0)}s`).join(", ")}`);
if (bad.length > 0) console.log(`Not passing: ${bad.map((r) => r.file).join(", ")}`);
process.exit(bad.length === 0 ? 0 : 1);
