import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findGpu } from "../../localmodels/gpu.ts";

describe("finding a GPU", () => {
  test("nvidia-smi listing a GPU means cuda, and the note names it", async () => {
    const r = await findGpu(async (program, args) => (program === "nvidia-smi" && args[0] === "-L" ? "GPU 0: NVIDIA GeForce RTX 4080 (UUID: GPU-1234)\n" : undefined));
    assert.equal(r.backend, "cuda");
    assert.equal(r.note, "found GPU 0: NVIDIA GeForce RTX 4080");
  });

  test("several GPUs are counted", async () => {
    const r = await findGpu(async () => "GPU 0: NVIDIA A (UUID: x)\nGPU 1: NVIDIA B (UUID: y)\n");
    assert.equal(r.note, "found GPU 0: NVIDIA A and 1 more");
  });

  test("no nvidia-smi, or nothing listed, means the CPU, with what to set instead", async () => {
    for (const out of [undefined, "", "No devices were found\n"]) {
      const r = await findGpu(async () => out);
      assert.equal(r.backend, undefined);
      assert.match(r.note, /runs on the CPU.*vulkan.*cuda/);
    }
  });
});
