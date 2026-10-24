import { z } from "zod";

/** The harness configuration file (`harness.yml`). Hand-edited; read with src/config.ts, never with the transcript codec. */
const name = z.string().regex(/^[a-z][a-z0-9_-]*$/, "lowercase letters, digits, _ and - only");

const model = z.object({
  provider: z.enum(["anthropic", "openai", "llama.cpp"]),
  model: z.string().min(1),
  base_url: z.url().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const mcpServer = z.union([
  z.object({ command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }),
  z.object({ url: z.url(), headers: z.record(z.string(), z.string()).optional() }),
]);

export const harnessConfig = z.object({
  version: z.literal(1),
  model,
  /** Tools the agent may use. Order is not meaningful and is normalised before sending to a provider. */
  tools: z.array(name).default([]),
  skills: z.array(name).default([]),
  mcp_servers: z.record(name, mcpServer).default({}),
  compaction: z.object({ threshold_tokens: z.number().int().positive(), keep_recent: z.number().int().nonnegative() }).optional(),
});

export type HarnessConfig = z.infer<typeof harnessConfig>;
