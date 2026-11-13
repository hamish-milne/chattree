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
  /** `run` only: allow `git`. Off by default: the thread's working directory is a repository chattree keeps, and the model's changes are saved without it. */
  git: z.boolean().optional(),
  /** `run` only, with `batch`: globs of batch files inside the workspace that may be started, such as `./node_modules/.bin/*.cmd`. */
  local: z.array(z.string().min(1)).optional(),
});

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name");

/**
 * An MCP server (docs/context.md, section 2): a program that speaks MCP on stdin and stdout (`command`), or an HTTP endpoint (`url`). Nothing
 * is started or contacted until the thread has accepted the server's configuration (`/mcp accept`), because a `harness.yml` can arrive with a
 * cloned repository. Secrets are named, never written here: `env_from` and `bearer_env` read the host's environment when the server is started.
 */
const mcpServer = z
  .strictObject({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    /** Environment values for the program that are not secret. */
    env: z.record(envName, z.string()).optional(),
    /** Host environment variables passed to the program unchanged (a token): the value never enters the transcript. */
    env_from: z.array(envName).optional(),
    url: z.url().optional(),
    /** Request headers that are not secret. */
    headers: z.record(z.string().min(1), z.string()).optional(),
    /** A host environment variable that holds a bearer token, sent as `Authorization: Bearer ...`. */
    bearer_env: envName.optional(),
    /** Header name to the host environment variable that holds its value. */
    header_env: z.record(z.string().min(1), envName).optional(),
    /** Offer only these of the server's tools (by their own names), or all but those in `skip`. */
    only: z.array(z.string().min(1)).optional(),
    skip: z.array(z.string().min(1)).optional(),
    /** Approvals for every tool of this server, as for `tools`: `all` covers any call until its date. */
    allow: z.record(z.string().min(1), untilTimestamp).default({}),
    /**
     * Where a program is run. `thread` (the default): in the worktree of the thread that uses it, so a server that works on files sees that
     * thread's files, and a subagent has a process of its own. `project`: in the project's main directory, one process for every thread (a
     * server with state of its own, such as a memory). A url is always shared.
     */
    scope: z.enum(["thread", "project"]).optional(),
  })
  .refine((s) => (s.command === undefined) !== (s.url === undefined), "give either command or url")
  .refine((s) => s.url === undefined || (s.args.length === 0 && s.env === undefined && s.env_from === undefined), "args and env belong to a command, not a url")
  .refine((s) => s.command === undefined || (s.headers === undefined && s.bearer_env === undefined && s.header_env === undefined), "headers belong to a url, not a command")
  .refine((s) => s.url === undefined || s.scope === undefined, "scope belongs to a command: a url is always shared");

export const harnessConfig = z.object({
  /** Providers by name (the name is what an agent's model setting refers to). */
  providers: z.record(name, provider).default({}),
  /**
   * Per-tool approvals, by tool name. A call runs without asking only when the tool's `allow` map holds an unexpired
   * key that covers it; a tool without an entry asks. `env` is not a tool: the environment variables `run` may expand.
   */
  tools: z.object({ env: z.array(z.string().min(1)).optional() }).catchall(toolEntry).default({}),
  /** MCP servers by name (lowercase letters, digits and single hyphens). Their tools are offered as `mcp__<name>__<tool>`. */
  mcp: z.record(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, digits and single hyphens").max(24), mcpServer).default({}),
  /** Background jobs (docs/tools.md, 3.5). */
  background: z
    .object({
      /** When a job ends while the conversation is idle, also send a request so the model can react. Off by default: it spends money unattended. */
      resume: z.boolean().default(false),
    })
    .default({ resume: false }),
  /**
   * Who is running a thread (docs/tools.md, 5.3). By default a file in this repository's git directory, which is enough for every
   * session on this machine. With `remote`, a ref on that remote instead, so clones that share it but not a git directory agree too.
   */
  leases: z.object({ remote: z.string().min(1) }).optional(),
  /** Threads talking to each other (docs/tools.md, 4.3). A parent and its children always may, if the tools are listed; siblings only with `siblings`. */
  threads: z.object({ siblings: z.boolean().default(false) }).default({ siblings: false }),
  /** Subagents (docs/tools.md, 4.2). */
  subagent: z
    .object({
      /** `auto`: a subagent hands its work back without asking. `review`: you are asked first, and see its report. */
      merge: z.enum(["auto", "review"]).default("auto"),
      /**
       * The MCP servers a subagent gets: `inherit` (the default) every one the thread has, `none`, or only the named ones. What it
       * inherits it uses with the approvals the thread had when it started.
       */
      mcp: z.union([z.enum(["inherit", "none"]), z.array(z.string().min(1)).min(1)]).default("inherit"),
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
    .default({ merge: "auto", mcp: "inherit" }),
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
  /**
   * Skills (docs/context.md, section 2). `follow` says what happens when a `SKILL.md` changes, appears or disappears on disk while a thread
   * runs: `ask` (default) reports it and `/skills sync` takes it, `auto` pins it at the start of the next request (the model is told where
   * it happened, the cached prefix is untouched), `off` never looks.
   */
  skills: z.object({ follow: z.enum(["auto", "ask", "off"]).default("ask") }).default({ follow: "ask" }),
  /**
   * Text the harness puts in front of the model before a request (docs/context.md, section 2); each is recorded in the transcript.
   * `usage`: tell the model when a request nears a limit or the context window (default on). `rules`: reminders by key (the key is what the rule is recorded under), each with a
   * `text` or a `file` (read from the thread's workspace when the rule fires), and `every` N responses since the last time (`first`: also on the first request).
   */
  injections: z
    .object({
      usage: z.boolean().default(true),
      /** Tell the model where it is (system, thread, date; docs/context.md, section 2). Default on. */
      environment: z.boolean().default(true),
      rules: z
        .record(
          z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, "lowercase letters, digits, and . _ -"),
          z
            .object({
              every: z.number().int().positive(),
              first: z.boolean().default(false),
              text: z.string().min(1).optional(),
              file: z.string().min(1).optional(),
            })
            .refine((r) => (r.text === undefined) !== (r.file === undefined), "give either text or file"),
        )
        .default({}),
    })
    .default({ usage: true, environment: true, rules: {} }),
  /**
   * Keeping the context within the window (docs/context.md, sections 5 and 6). With `auto` on, a request that would reach `threshold_tokens` (default:
   * 70% of the model's context window, which leaves room to finish a long tool loop) is trimmed first; `auto: full` then writes a summary if the trim
   * was not enough, between turns only. The last `keep_recent` entries stay whole.
   */
  compaction: z
    .object({
      threshold_tokens: z.number().int().positive().optional(),
      keep_recent: z.number().int().nonnegative().default(12),
      auto: z.enum(["off", "trim", "full"]).default("off"),
      /** What a trim leaves out, as sizes in bytes (`reasoning`: all of it). */
      trim: z.object({ tool_results: z.number().int().nonnegative().default(2048), tool_args: z.number().int().nonnegative().default(2048), reasoning: z.boolean().default(true) }).default({ tool_results: 2048, tool_args: 2048, reasoning: true }),
      /** The model that writes summaries, of the thread's provider. Default: the thread's own model. */
      summary_model: z.string().min(1).optional(),
      /** What the summarizer reads: `seen`, what the main model sees (past summaries and trimmed entries); or `raw`, the entries since the last summary untrimmed (falls back to `seen` if that does not fit). */
      summary_input: z.enum(["seen", "raw"]).default("seen"),
      /** The share of the threshold (at 3 bytes to a token) that the summaries in the context may take. While they fit, a new summary covers only what came after them and they stay as they are (cache-friendly); beyond it, the new one takes them in and covers everything. */
      summary_budget: z.number().gt(0).lt(1).default(0.15),
    })
    .optional(),
});

export type HarnessConfig = z.infer<typeof harnessConfig>;
