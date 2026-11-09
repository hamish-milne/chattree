import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nightlyTagIn, parseAssetName, resolveBackend, resolveVersionTag, selectAsset, type ReleaseAsset } from "../../localmodels/release.ts";

const names = `cudart-llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz
cudart-llama-b12110-bin-ubuntu-cuda-13.4-x64.tar.gz
cudart-llama-bin-win-cuda-12.4-x64.zip
cudart-llama-bin-win-cuda-13.4-x64.zip
llama-b12110-bin-android-arm64-snapdragon.tar.gz
llama-b12110-bin-macos-arm64.tar.gz
llama-b12110-bin-macos-x64.tar.gz
llama-b12110-bin-ubuntu-26.04-s390x.tar.gz
llama-b12110-bin-ubuntu-arm64.tar.gz
llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz
llama-b12110-bin-ubuntu-cuda-13.4-x64.tar.gz
llama-b12110-bin-ubuntu-openvino-2026.4.1-x64.tar.gz
llama-b12110-bin-ubuntu-sycl-fp16-x64.tar.gz
llama-b12110-bin-ubuntu-vulkan-x64.tar.gz
llama-b12110-bin-ubuntu-x64.tar.gz
llama-b12110-bin-win-cpu-x64.zip
llama-b12110-bin-win-cuda-12.4-x64.zip
llama-b12110-bin-win-cuda-13.4-x64.zip
llama-b12110-bin-win-vulkan-x64.zip
llama-b12110-ui.tar.gz
llama-b12110-xcframework.zip`.split("\n");
const assets: ReleaseAsset[] = names.map((name) => ({ name, url: `https://example.test/${name}` }));

describe("asset names", () => {
  test("are taken apart", () => {
    assert.deepEqual(parseAssetName("llama-b12110-bin-win-cuda-12.4-x64.zip"), { kind: "llama", tag: "b12110", os: "win", arch: "x64", backend: "cuda", cuda: "12.4", ext: "zip" });
    assert.deepEqual(parseAssetName("cudart-llama-bin-win-cuda-12.4-x64.zip"), { kind: "cudart", tag: undefined, os: "win", arch: "x64", backend: "cuda", cuda: "12.4", ext: "zip" });
    assert.equal(parseAssetName("llama-b12110-bin-macos-arm64.tar.gz")?.backend, "metal");
    assert.equal(parseAssetName("llama-b12110-bin-ubuntu-x64.tar.gz")?.backend, "cpu");
    assert.equal(parseAssetName("llama-b12110-bin-ubuntu-sycl-fp16-x64.tar.gz")?.backend, "sycl");
    assert.equal(parseAssetName("llama-b12110-bin-ubuntu-openvino-2026.4.1-x64.tar.gz")?.backend, "openvino");
    assert.equal(parseAssetName("llama-b12110-bin-ubuntu-26.04-s390x.tar.gz")?.backend, "cpu");
    assert.equal(parseAssetName("llama-b12110-ui.tar.gz"), undefined);
    assert.equal(parseAssetName("llama-b12110-xcframework.zip"), undefined);
  });
});

describe("choosing the file", () => {
  const pick = (o: Parameters<typeof selectAsset>[1]) => {
    const r = selectAsset(assets, o);
    return r.ok ? { program: r.selection.program.name, runtime: r.selection.runtime?.name } : r.error;
  };

  test("auto is Metal on a Mac and the CPU elsewhere", () => {
    assert.equal(resolveBackend("auto", "macos"), "metal");
    assert.equal(resolveBackend("auto", "linux"), "cpu");
    assert.equal(resolveBackend("auto", "windows", undefined), "cpu");
  });

  test("auto takes the GPU backend that was found, but never over a Mac's Metal or an explicit choice", () => {
    assert.equal(resolveBackend("auto", "windows", "cuda"), "cuda");
    assert.equal(resolveBackend("auto", "linux", "cuda"), "cuda");
    assert.equal(resolveBackend("auto", "macos", "cuda"), "metal");
    assert.equal(resolveBackend("cpu", "linux", "cuda"), "cpu");
    assert.equal(resolveBackend("vulkan", "windows", "cuda"), "vulkan");
    assert.deepEqual(pick({ platform: "macos", arch: "arm64", backend: "auto" }), { program: "llama-b12110-bin-macos-arm64.tar.gz", runtime: undefined });
    assert.deepEqual(pick({ platform: "windows", arch: "x64", backend: "auto" }), { program: "llama-b12110-bin-win-cpu-x64.zip", runtime: undefined });
    assert.deepEqual(pick({ platform: "linux", arch: "x64", backend: "auto" }), { program: "llama-b12110-bin-ubuntu-x64.tar.gz", runtime: undefined });
  });

  test("cuda takes the newest version, or the one asked for, with its runtime", () => {
    assert.deepEqual(pick({ platform: "windows", arch: "x64", backend: "cuda" }), { program: "llama-b12110-bin-win-cuda-13.4-x64.zip", runtime: "cudart-llama-bin-win-cuda-13.4-x64.zip" });
    assert.deepEqual(pick({ platform: "windows", arch: "x64", backend: "cuda", cuda: "12" }), { program: "llama-b12110-bin-win-cuda-12.4-x64.zip", runtime: "cudart-llama-bin-win-cuda-12.4-x64.zip" });
    assert.deepEqual(pick({ platform: "linux", arch: "x64", backend: "cuda", cuda: "12.8" }), { program: "llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz", runtime: "cudart-llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz" });
    assert.match(String(pick({ platform: "linux", arch: "x64", backend: "cuda", cuda: "11" })), /no CUDA 11 build.*12\.8, 13\.4/);
  });

  test("a missing build says what the release does have", () => {
    assert.match(String(pick({ platform: "linux", arch: "arm64", backend: "vulkan" })), /no vulkan build for linux arm64 \(it has: cpu\)/);
    assert.match(String(pick({ platform: "windows", arch: "x64", backend: "metal" })), /no metal build/);
  });
});

describe("version tags", () => {
  test("lead to the build the release links", () => {
    const body = "Release notes.\nBuilds: https://github.com/ggml-org/llama.cpp/releases/tag/b12110\nand older https://github.com/ggml-org/llama.cpp/releases/tag/b9";
    assert.equal(nightlyTagIn(body), "b12110");
    assert.deepEqual(resolveVersionTag("v0.9.0", body), { ok: true, tag: "b12110" });
    const none = resolveVersionTag("v0.9.0", "nothing here");
    assert.equal(none.ok, false);
    assert.match(none.ok ? "" : none.error, /v0\.9\.0.*b12110/);
  });
});
