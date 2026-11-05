import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HttpFixture } from "./http-fixture.ts";

/** A tar.gz holding the given files, built with the system `tar`. */
export async function tarball(dir: string, name: string, files: Record<string, string>): Promise<Buffer> {
  const src = join(dir, `src-${name}`);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(src, path, ".."), { recursive: true });
    await writeFile(join(src, path), text);
  }
  const out = join(dir, name);
  execFileSync("tar", ["-czf", out, "-C", src, "."]);
  return readFile(out);
}

export const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** A fake llama.cpp release b100 (and a version tag v0.9.0 that links to it) on the fixture, as the GitHub API and the download addresses. */
export async function fakeLlamaRelease(server: HttpFixture, work: string, digest: (b: Buffer) => string = sha): Promise<void> {
  const program = await tarball(work, "program.tar.gz", { "llama-b100/llama-server": "#!/bin/sh\n", "llama-b100/libllama.so": "lib" });
  const cudart = await tarball(work, "cudart.tar.gz", { "libcudart.so.12": "cuda" });
  const asset = (name: string, b: Buffer) => ({ name, size: b.length, digest: `sha256:${digest(b)}`, browser_download_url: `${server.base}/dl/${name}` });
  const assets = [
    asset("llama-b100-bin-ubuntu-x64.tar.gz", program),
    asset("llama-b100-bin-ubuntu-cuda-12.8-x64.tar.gz", program),
    asset("cudart-llama-b100-bin-ubuntu-cuda-12.8-x64.tar.gz", cudart),
  ];
  server
    .on("/repos/ggml-org/llama.cpp/releases/tags/b100", { body: JSON.stringify({ body: "", assets }) })
    .on("/repos/ggml-org/llama.cpp/releases/tags/v0.9.0", { body: JSON.stringify({ body: "Builds https://github.com/ggml-org/llama.cpp/releases/tag/b100", assets: [] }) })
    .on("/repos/ggml-org/llama.cpp/releases/tags/v0.1.0", { body: JSON.stringify({ body: "no link", assets: [] }) })
    .on("/dl/llama-b100-bin-ubuntu-x64.tar.gz", { body: program })
    .on("/dl/llama-b100-bin-ubuntu-cuda-12.8-x64.tar.gz", { body: program })
    .on("/dl/cudart-llama-b100-bin-ubuntu-cuda-12.8-x64.tar.gz", { body: cudart });
}
