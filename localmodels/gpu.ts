import { execFile } from "node:child_process";

/** What `backend: auto` found on this machine. */
export interface GpuFinding {
  /** The backend to use: `cuda` when an NVIDIA GPU was found; otherwise none, which means the CPU. */
  backend: "cuda" | undefined;
  /** Said to the person when it matters: what was found, or why the CPU is being used and what to set instead. */
  note: string;
}

export type RunProgram = (program: string, args: string[]) => Promise<string | undefined>;

/** Run a program and return its output; undefined when it is not there, fails or takes too long. */
export const runProgram: RunProgram = (program, args) =>
  new Promise((resolve) => {
    execFile(program, args, { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error === null ? stdout : undefined));
  });

/**
 * Look for a GPU llama.cpp can use without being told. Only NVIDIA is recognised, by `nvidia-smi -L`, which comes with its driver; for an
 * AMD or Intel card the person says `backend: vulkan` (guessing it would also pick an integrated GPU slower than the CPU).
 */
export async function findGpu(run: RunProgram = runProgram): Promise<GpuFinding> {
  const out = await run("nvidia-smi", ["-L"]);
  const gpus = (out ?? "").split("\n").filter((l) => /^GPU \d+:/.test(l.trim()));
  if (gpus.length > 0) return { backend: "cuda", note: `found ${gpus[0]?.replace(/\s*\(UUID:.*$/, "").trim()}${gpus.length > 1 ? ` and ${gpus.length - 1} more` : ""}` };
  return { backend: undefined, note: "no NVIDIA GPU found (nvidia-smi did not list one), so llama.cpp runs on the CPU, which is slow and loads every core; for an AMD or Intel GPU set local_models.llama_cpp.backend to vulkan, for NVIDIA to cuda" };
}
