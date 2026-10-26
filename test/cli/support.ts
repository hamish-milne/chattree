import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { nodeHost } from "../../hosts/node.ts";
import type { Io } from "../../cli/io.ts";
import { tempDir } from "../support/tmp.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";

export const host = nodeHost();

export const chunk = (delta: object, finish: string | null = null): string => `data: ${JSON.stringify({ id: "c1", model: "qwen3:4b", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
export const usageChunk = (p: number, c: number): string => `data: ${JSON.stringify({ id: "c1", model: "qwen3:4b", choices: [], usage: { prompt_tokens: p, completion_tokens: c } })}\n\n`;
/** A complete streamed answer. */
export const answer = (text: string, p = 20, c = 5): Reply => ({ acts: [chunk({ content: text }), chunk({}, "stop"), usageChunk(p, c), "data: [DONE]\n\n"] });

export interface Captured extends Io {
  stdout: string;
  stderr: string;
}

export function testIo(cwd: string, over: Partial<Io> & { stdin?: string } = {}): Captured {
  const cap: Captured = {
    host,
    stdout: "",
    stderr: "",
    out: (t) => void (cap.stdout += t),
    err: (t) => void (cap.stderr += t),
    env: {},
    cwd,
    interactive: false,
    readStdin: async () => new TextEncoder().encode(over.stdin ?? ""),
    now: Date.now,
    ...over,
  };
  return cap;
}

/** A new project (a conversation on a fake OpenAI-compatible server) ready for the CLI, via `chattree init`. */
export async function project(server: FakeServer, opts: { cwd?: string } = {}): Promise<{ dir: string; base: string }> {
  const base = await tempDir();
  const dir = opts.cwd ?? join(base, "p");
  await mkdir(dir, { recursive: true });
  return { dir, base };
}

export const initArgs = (server: FakeServer, dir: string): string[] => ["init", dir, "--provider", "compatible", "--base-url", `${server.url}/v1`, "--model", "qwen3:4b", "--max-output", "256"];
