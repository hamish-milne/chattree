import { z } from "zod";

/**
 * The harness configuration file (`harness.yml`): the outside world only. Machine setup (which providers, the
 * names of the environment variables holding their keys), the harness's disposition (limits), and host wiring.
 * Everything that describes the agent itself (model, settings, tools, instructions) is state in the
 * transcript (`agent_setup`), never here. Hand-edited; read with src/config.ts, never with the transcript codec.
 * Its history is the repository's: put the reason for a change in the commit message.
 */
const name = z.string().regex(/^[a-z][a-z0-9_-]*$/, "lowercase letters, digits, _ and - only");

/**
 * One provider. `$tag` says which adapter handles it (`!anthropic` in the file is the same as `$tag: anthropic`);
 * the adapter's own schema validates the rest, so here the remaining keys pass through.
 */
const provider = z.looseObject({ $tag: z.string().min(1) });

const usd = z.number().positive();

export const harnessConfig = z.object({
  /** Providers by name (the name is what an agent's model setting refers to). */
  providers: z.record(name, provider).default({}),
  /** Hard limits: a request that would exceed one is not sent. To go past one, change it here. */
  limits: z
    .object({
      max_request_usd: usd.optional(),
      max_turn_usd: usd.optional(),
      max_conversation_usd: usd.optional(),
      /** Requests (assistant responses) allowed since the last user message, tool loops included. */
      max_requests_per_turn: z.number().int().positive().optional(),
      /** Wall-clock seconds for one turn. Enforced by the turn runner. */
      max_turn_seconds: z.number().positive().optional(),
      /** Raise a warning when spend reaches this fraction of a limit. */
      warn_at: z.number().gt(0).lt(1).optional(),
      /** What to do when a request's price is unknown (no table entry): `warn` (default) or `block`. */
      unknown_price: z.enum(["warn", "block"]).optional(),
    })
    .default({}),
  compaction: z.object({ threshold_tokens: z.number().int().positive(), keep_recent: z.number().int().nonnegative() }).optional(),
});

export type HarnessConfig = z.infer<typeof harnessConfig>;
