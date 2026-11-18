import type { Fs, PathOps } from "../src/index.ts";

/**
 * Swapping ignored files between two worktrees. Thread switching trades branches between the project folder and a
 * thread's worktree, and what git ignores (`node_modules`, build output, virtual environments) belongs to the folder, not to any
 * branch, so without this every switch would need an install. The entries are swapped by rename, which costs nothing
 * on one disk; across disks a rename is a copy, so the entries stay where they are.
 */

export interface SwapResult {
  /** Top-level names that now sit in the other folder. */
  moved: string[];
  /** Names not moved, and why. */
  left: { name: string; reason: string }[];
  /** Put everything moved back where it was. Idempotent. */
  undo(): Promise<void>;
}

/** What each folder offers: the top-level names git ignores in it. */
export interface SwapSides {
  a: { dir: string; ignored: readonly string[] };
  b: { dir: string; ignored: readonly string[] };
}

/** Never moved: git's own, and the harness's per-folder generated files and keys. */
const KEEP = new Set([".git", ".chattree"]);

const codeOf = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" ? e.code : undefined;

export async function swapIgnored(io: { fs: Fs; path: PathOps }, sides: SwapSides): Promise<SwapResult> {
  const { fs, path } = io;
  const left: SwapResult["left"] = [];
  const names = [...new Set([...sides.a.ignored, ...sides.b.ignored])].filter((n) => !KEEP.has(n)).sort();
  const inA = new Set(sides.a.ignored);
  const inB = new Set(sides.b.ignored);

  // What each name needs: a swap when both folders have it ignored, a move when one does and the other has nothing
  // by that name. A name taken by something git does not ignore (a tracked directory, say) stays.
  const plan: { name: string; steps: [string, string][] }[] = [];
  for (const name of names) {
    const pa = path.join(sides.a.dir, name);
    const pb = path.join(sides.b.dir, name);
    if (inA.has(name) && inB.has(name)) {
      plan.push({ name, steps: [[pa, pb]] });
    } else if (inA.has(name)) {
      if ((await fs.stat(pb)) !== undefined) left.push({ name, reason: "the other folder has a tracked or unignored entry of that name" });
      else plan.push({ name, steps: [[pa, pb]] });
    } else if ((await fs.stat(pa)) !== undefined)
      left.push({ name, reason: "the other folder has a tracked or unignored entry of that name" });
    else plan.push({ name, steps: [[pb, pa]] });
  }

  const done: [string, string][] = []; // each is a rename from -> to that happened, in order
  const undo = async (): Promise<void> => {
    while (done.length > 0) {
      const last = done.pop();
      if (last !== undefined) await fs.rename(last[1], last[0]);
    }
  };
  const movedNames: string[] = [];
  const tmpFor = (name: string): string => path.join(sides.a.dir, `.chattree-swap-${Math.random().toString(36).slice(2, 10)}-${name}`);
  try {
    for (const { name, steps } of plan) {
      const [from, to] = steps[0] ?? ["", ""];
      if (inA.has(name) && inB.has(name)) {
        const tmp = tmpFor(name);
        await fs.rename(from, tmp);
        done.push([from, tmp]);
        await fs.rename(to, from);
        done.push([to, from]);
        await fs.rename(tmp, to);
        done.push([tmp, to]);
      } else {
        await fs.rename(from, to);
        done.push([from, to]);
      }
      movedNames.push(name);
    }
  } catch (e) {
    await undo();
    if (codeOf(e) === "EXDEV") {
      return {
        moved: [],
        left: names.map((name) => ({ name, reason: "the folders are on different disks, so moving would copy" })),
        undo: async () => undefined,
      };
    }
    throw e;
  }
  return { moved: movedNames, left, undo };
}
