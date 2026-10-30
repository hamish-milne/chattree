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

/**
 * When a grant ends: a date (00:00 UTC) or a datetime that carries its zone. "Forever" is a far-future date
 * (`2999-01-01`), not a special word. YAML 1.2 reads both as plain strings.
 */
export const untilTimestamp = z.string().refine(
  (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) && !Number.isNaN(Date.parse(s)),
  "expected a date (2999-01-01) or a datetime with a zone (2026-10-27T15:00:00Z)",
);

/** One tool's approvals (docs/tools.md, section 5): the keys the user has granted, each with the time it ends. */
const toolEntry = z.object({
  /** Key to expiry. `all` covers every call; other keys are the tool's own (for `run`, argv patterns such as `grep **`). */
  allow: z.record(z.string().min(1), untilTimestamp).default({}),
  /** `run` only: programs known to be read-only, which may be granted as `<program> **`. */
  safe: z.array(z.string().min(1)).optional(),
  /**
   * `run` only, Windows: start `.cmd` and `.bat` programs (npm, pnpm, build scripts) through cmd.exe. Off by default because cmd.exe
   * re-interprets the command line; arguments with its special characters are refused (see harness/starter/batch.ts).
   */
  batch: z.boolean().optional(),
  /** `run` only, with `batch`: globs of batch files inside the workspace that may be started, such as `./node_modules/.bin/*.cmd`. */
  local: z.array(z.string().min(1)).optional(),
  /** Windows: where `run` gets cat, ls, grep and the rest. `auto` (the default) uses the busybox.exe that is there or fetches the pinned release, `off` never fetches, anything else is the path of a busybox.exe. */
  busybox: z.string().min(1).optional(),
});

export const harnessConfig = z.object({
  /** Providers by name (the name is what an agent's model setting refers to). */
  providers: z.record(name, provider).default({}),
  /**
   * Per-tool approvals, by tool name. A call runs without asking only when the tool's `allow` map holds an unexpired
   * key that covers it; a tool without an entry asks. `env` is not a tool: the environment variables `run` may expand.
   */
  tools: z.object({ env: z.array(z.string().min(1)).optional() }).catchall(toolEntry).default({}),
  /** Background jobs (docs/tools.md, 3.5). */
  background: z
    .object({
      /** When a job ends while the conversation is idle, also send a request so the model can react. Off by default: it spends money unattended. */
      resume: z.boolean().default(false),
    })
    .default({ resume: false }),
  /** Subagents (docs/tools.md, 4.2). */
  subagent: z
    .object({
      /** `auto`: a subagent hands its work back without asking. `review`: you are asked first, and see its report. */
      merge: z.enum(["auto", "review"]).default("auto"),
      /**
       * The models the parent may choose for a subagent, as `provider/model` (the provider is a name from `providers`). Without this
       * the subagent always uses the parent's own model and the tool has no `model` argument. What each is good at, its cost tier
       * and its reasoning levels come from the provider's `models` catalog; the entry here can narrow the levels or reword the description.
       */
      models: z
        .record(
          z.string().regex(/^[^\s/@]+\/[^\s@]+$/, "write it as provider/model, without spaces or @"),
          z.strictObject({
            description: z.string().min(1).optional(),
            /** Only these reasoning levels are offered for the model (default: every level the catalog has). */
            reasoning: z.array(z.string().min(1)).min(1).optional(),
          }),
        )
        .optional(),
    })
    .default({ merge: "auto" }),
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
      /** Seconds one tool call may take unless the tool says otherwise (default 600): the loop stops it then, and the thread's run lease is held that long. */
      max_tool_seconds: z.number().positive().optional(),
      /** Seconds one model request may take (default 600, the provider layer's own total limit): how long the run lease is held for it. */
      max_request_seconds: z.number().positive().optional(),
      /** Raise a warning when spend reaches this fraction of a limit. */
      warn_at: z.number().gt(0).lt(1).optional(),
      /** What to do when a request's price is unknown (no table entry): `warn` (default) or `block`. */
      unknown_price: z.enum(["warn", "block"]).optional(),
    })
    .default({}),
  /**
   * Keeping the repository small. Git's own `gc.auto` is off so nothing rewrites the repository behind a running
   * conversation; instead the harness packs loose objects itself (`git repack -d`, which never deletes anything
   * reachable or unreachable-but-new) when the repository grows past these figures, checked when a conversation
   * is opened and every `check_every` transactions after.
   */
  maintenance: z
    .object({
      auto: z.boolean().default(true),
      /** Pack loose objects once there are more than this many. */
      loose_objects: z.number().int().positive().default(1000),
      /** Merge packs into one (`repack -a -d`) once there are more than this many. */
      packs: z.number().int().positive().default(20),
      /** Look again after this many appends, snapshots and the like. */
      check_every: z.number().int().positive().default(200),
    })
    .default({ auto: true, loose_objects: 1000, packs: 20, check_every: 200 }),
  /** Files added to messages (`Conversation.attach`). */
  attachments: z.object({ max_bytes: z.number().int().positive().default(20 * 1024 * 1024) }).default({ max_bytes: 20 * 1024 * 1024 }),
  compaction: z.object({ threshold_tokens: z.number().int().positive(), keep_recent: z.number().int().nonnegative() }).optional(),
});

export type HarnessConfig = z.infer<typeof harnessConfig>;
