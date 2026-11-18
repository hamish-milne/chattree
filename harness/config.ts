import { Type, type Static, type StaticDecode, type TSchema } from "typebox";
import { pattern, record, rules, said, section, strictObject, withDefault } from "../src/validate.ts";

/**
 * The harness configuration file (`harness.yml`): the outside world only. Machine setup (which providers, the
 * names of the environment variables holding their keys), the harness's disposition (limits), and host wiring.
 * Everything that describes the agent itself (model, settings, tools, instructions) is state in the
 * transcript (`agent_setup`), never here. Hand-edited; read with src/config.ts, never with the transcript codec.
 * Its history is the repository's: put the reason for a change in the commit message.
 */
const opt = Type.Optional;
const nonEmpty = Type.String({ minLength: 1 });
const positive = Type.Integer({ minimum: 1 });
const positiveNumber = Type.Number({ exclusiveMinimum: 0 });
const fraction = Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 });

const name = pattern(/^[a-z][a-z0-9_-]*$/, "lowercase letters, digits, _ and - only");

/**
 * One provider. `$tag` says which adapter handles it (`!anthropic` in the file is the same as `$tag: anthropic`);
 * the adapter's own schema validates the rest, so here the remaining keys pass through.
 */
const provider = Type.Unsafe<{ $tag: string } & Record<string, unknown>>(Type.Object({ $tag: nonEmpty }));

const usd = positiveNumber;

/**
 * When a grant ends: a date (00:00 UTC) or a datetime that carries its zone. "Forever" is a far-future date
 * (`2999-01-01`), not a special word. YAML 1.2 reads both as plain strings.
 */
const UNTIL_SENTENCE = "expected a date (2999-01-01) or a datetime with a zone (2026-10-27T15:00:00Z)";
export const untilTimestamp = rules(
  said(UNTIL_SENTENCE, Type.String({ pattern: String.raw`^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$` })),
  [(s) => (Number.isNaN(Date.parse(s)) ? UNTIL_SENTENCE : undefined)],
);

/** One tool's approvals: the keys the user has granted, each with the time it ends. */
const toolEntry = strictObject({
  /**
   * Key to expiry. `all` covers every call; other keys are the tool's own (for `run`, argv patterns such as `grep **`).
   */
  allow: withDefault(record(nonEmpty, untilTimestamp), {}),
  /** `run` only: programs known to be read-only, which may be granted as `<program> **`. */
  safe: opt(Type.Array(nonEmpty)),
  /**
   * `run` only, Windows: start `.cmd` and `.bat` programs (npm, pnpm, build scripts) through cmd.exe. Off by default because cmd.exe
   * re-interprets the command line; arguments with its special characters are refused (see harness/starter/batch.ts).
   */
  batch: opt(Type.Boolean()),
  /**
   * `run` only: allow `git`. Off by default: the thread's working directory is a repository chattree keeps, and the
   * model's changes are saved without it.
   */
  git: opt(Type.Boolean()),
  /** `run` only, with `batch`: globs of batch files inside the workspace that may be started, such as `./node_modules/.bin/*.cmd`. */
  local: opt(Type.Array(nonEmpty)),
});

/**
 * `env` (a list) and every other key (a tool's entry). JSON Schema says it plainly: `env` is a property, the rest are
 * `additionalProperties`. TypeBox's inferred type leaves the additional ones out, so the type is given here.
 */
type ToolsSection = { env?: string[] } & Record<string, Static<typeof toolEntry>>;
const toolsSection = withDefault<TSchema, ToolsSection>(
  Type.Object({ env: opt(Type.Array(nonEmpty)) }, { additionalProperties: toolEntry }),
  {},
);

const envName = pattern(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name");

/**
 * An MCP server: a program that speaks MCP on stdin and stdout (`command`), or an HTTP endpoint (`url`). Nothing is
 * started or contacted until the thread has accepted the server's configuration (`/mcp accept`), because a
 * `harness.yml` can arrive with a cloned repository. Secrets are named, never written here: `env_from` and `bearer_env`
 * read the host's environment when the server is started.
 */
const mcpServer = rules(
  strictObject({
    command: opt(nonEmpty),
    args: withDefault(Type.Array(Type.String()), []),
    /** Environment values for the program that are not secret. */
    env: opt(record(envName, Type.String())),
    /** Host environment variables passed to the program unchanged (a token): the value never enters the transcript. */
    env_from: opt(Type.Array(envName)),
    url: opt(Type.String({ format: "url" })),
    /** Request headers that are not secret. */
    headers: opt(record(nonEmpty, Type.String())),
    /** A host environment variable that holds a bearer token, sent as `Authorization: Bearer ...`. */
    bearer_env: opt(envName),
    /** Header name to the host environment variable that holds its value. */
    header_env: opt(record(nonEmpty, envName)),
    /** Offer only these of the server's tools (by their own names), or all but those in `skip`. */
    only: opt(Type.Array(nonEmpty)),
    skip: opt(Type.Array(nonEmpty)),
    /** Approvals for every tool of this server, as for `tools`: `all` covers any call until its date. */
    allow: withDefault(record(nonEmpty, untilTimestamp), {}),
    /**
     * Where a program is run. `thread` (the default): in the worktree of the thread that uses it, so a server that works on files sees that
     * thread's files, and a subagent has a process of its own. `project`: in the project's main directory, one process for every thread (a
     * server with state of its own, such as a memory). A url is always shared.
     */
    scope: opt(Type.Enum(["thread", "project"])),
  }),
  [
    (s) => ((s.command === undefined) === (s.url === undefined) ? "give either command or url" : undefined),
    (s) =>
      s.url !== undefined && (s.args.length > 0 || s.env !== undefined || s.env_from !== undefined)
        ? "args and env belong to a command, not a url"
        : undefined,
    (s) =>
      s.command !== undefined && (s.headers !== undefined || s.bearer_env !== undefined || s.header_env !== undefined)
        ? "headers belong to a url, not a command"
        : undefined,
    (s) => (s.url !== undefined && s.scope !== undefined ? "scope belongs to a command: a url is always shared" : undefined),
  ],
);

const injectionRule = rules(
  strictObject({
    every: positive,
    first: withDefault(Type.Boolean(), false),
    text: opt(nonEmpty),
    file: opt(nonEmpty),
  }),
  [(r) => ((r.text === undefined) === (r.file === undefined) ? "give either text or file" : undefined)],
);

export const harnessConfig = strictObject({
  /** Providers by name (the name is what an agent's model setting refers to). */
  providers: withDefault(record(name, provider), {}),
  /**
   * Per-tool approvals, by tool name. A call runs without asking only when the tool's `allow` map holds an unexpired
   * key that covers it; a tool without an entry asks. `env` is not a tool: the environment variables `run` may expand.
   */
  tools: toolsSection,
  /** MCP servers by name (lowercase letters, digits and single hyphens). Their tools are offered as `mcp__<name>__<tool>`. */
  mcp: withDefault(
    record(
      said(
        "lowercase letters, digits and single hyphens, at most 24 characters",
        Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 24 }),
      ),
      mcpServer,
    ),
    {},
  ),
  /** Background jobs. */
  background: section({
    /**
     * When a job ends while the conversation is idle, also send a request so the model can react. Off by default: it
     * spends money unattended.
     */
    resume: withDefault(Type.Boolean(), false),
  }),
  /**
   * Who is running a thread. By default a file in this repository's git directory, which is enough for every session on
   * this machine. With `remote`, a ref on that remote instead, so clones that share it but not a git directory agree too.
   */
  leases: opt(strictObject({ remote: nonEmpty })),
  /**
   * Threads talking to each other. A parent and its children always may, if the tools are listed; siblings only with
   * `siblings`.
   */
  threads: section({ siblings: withDefault(Type.Boolean(), false) }),
  /** Subagents. */
  subagent: section({
    /** `auto`: a subagent hands its work back without asking. `review`: you are asked first, and see its report. */
    merge: withDefault(Type.Enum(["auto", "review"]), "auto"),
    /**
     * The MCP servers a subagent gets: `inherit` (the default) every one the thread has, `none`, or only the named ones. What it
     * inherits it uses with the approvals the thread had when it started.
     */
    mcp: withDefault(Type.Union([Type.Enum(["inherit", "none"]), Type.Array(nonEmpty, { minItems: 1 })]), "inherit"),
    /**
     * The models the parent may choose for a subagent, as `provider/model` (the provider is a name from `providers`). Without this
     * the subagent always uses the parent's own model and the tool has no `model` argument. What each is good at, its cost tier
     * and its reasoning levels come from the provider's `models` catalog; the entry here can narrow the levels or reword the description.
     */
    models: opt(
      record(
        pattern(/^[^\s/@]+\/[^\s@]+$/, "provider/model, without spaces or @"),
        strictObject({
          description: opt(nonEmpty),
          /** Only these reasoning levels are offered for the model (default: every level the catalog has). */
          reasoning: opt(Type.Array(nonEmpty, { minItems: 1 })),
        }),
      ),
    ),
  }),
  /** Hard limits: a request that would exceed one is not sent. To go past one, change it here. */
  limits: section({
    max_request_usd: opt(usd),
    max_turn_usd: opt(usd),
    max_conversation_usd: opt(usd),
    /** Requests (assistant responses) allowed since the last user message, tool loops included. */
    max_requests_per_turn: opt(positive),
    /** Wall-clock seconds for one turn. Enforced by the turn runner. */
    max_turn_seconds: opt(positiveNumber),
    /**
     * Seconds one tool call may take unless the tool says otherwise (default 600): the loop stops it then, and the
     * thread's run lease is held that long.
     */
    max_tool_seconds: opt(positiveNumber),
    /**
     * Seconds one model request may take (default 600, the provider layer's own total limit): how long the run lease
     * is held for it.
     */
    max_request_seconds: opt(positiveNumber),
    /** Raise a warning when spend reaches this fraction of a limit. */
    warn_at: opt(fraction),
    /** What to do when a request's price is unknown (no table entry): `warn` (default) or `block`. */
    unknown_price: opt(Type.Enum(["warn", "block"])),
  }),
  /**
   * Keeping the repository small. Git's own `gc.auto` is off so nothing rewrites the repository behind a running
   * conversation; instead the harness packs loose objects itself (`git repack -d`, which never deletes anything
   * reachable or unreachable-but-new) when the repository grows past these figures, checked when a conversation
   * is opened and every `check_every` transactions after.
   */
  maintenance: section({
    auto: withDefault(Type.Boolean(), true),
    /** Pack loose objects once there are more than this many. */
    loose_objects: withDefault(Type.Integer({ minimum: 1 }), 1000),
    /** Merge packs into one (`repack -a -d`) once there are more than this many. */
    packs: withDefault(Type.Integer({ minimum: 1 }), 20),
    /** Look again after this many appends, snapshots and the like. */
    check_every: withDefault(Type.Integer({ minimum: 1 }), 200),
  }),
  /**
   * Moving the workspace to another thread (`Conversation.switchWorkspace`): the project folder and that thread's worktree trade
   * branches. `ignored` says what happens to git-ignored files such as `node_modules`: `move` (default) swaps them
   * between the two folders so nothing needs installing again (beware of anything holding an absolute path to its
   * folder, such as a Python virtual environment); `leave` keeps them where they are.
   */
  workspace: section({ switch: section({ ignored: withDefault(Type.Enum(["move", "leave"]), "move") }) }),
  /** Files added to messages (`Conversation.attach`). The default cap is 20 MiB. */
  attachments: section({ max_bytes: withDefault(Type.Integer({ minimum: 1 }), 20 * 1024 * 1024) }),
  /**
   * Skills. `follow` says what happens when a `SKILL.md` changes, appears or disappears on disk while a thread runs:
   * `ask` (default) reports it and `/skills sync` takes it, `auto` pins it at the start of the next request (the model is
   * told where it happened, the cached prefix is untouched), `off` never looks.
   */
  skills: section({ follow: withDefault(Type.Enum(["auto", "ask", "off"]), "ask") }),
  /**
   * Text the harness puts in front of the model before a request; each is recorded in the transcript. `usage`: tell the
   * model when a request nears a limit or the context window (default on). `rules`: reminders by key (the key is what the
   * rule is recorded under), each with a `text` or a `file` (read from the thread's workspace when the rule fires), and
   * `every` N responses since the last time (`first`: also on the first request).
   */
  injections: section({
    usage: withDefault(Type.Boolean(), true),
    /** Tell the model where it is (system, thread, date). Default on. */
    environment: withDefault(Type.Boolean(), true),
    rules: withDefault(record(pattern(/^[a-z0-9][a-z0-9_.-]*$/, "lowercase letters, digits, and . _ -"), injectionRule), {}),
  }),
  /**
   * Keeping the context within the window. With `auto` on, a request that would reach `threshold_tokens` (default: 70%
   * of the model's context window, which leaves room to finish a long tool loop) is trimmed first; `auto: full` then
   * writes a summary if the trim was not enough, between turns only. The last `keep_recent` entries stay whole.
   */
  compaction: opt(
    strictObject({
      threshold_tokens: opt(positive),
      keep_recent: withDefault(Type.Integer({ minimum: 0 }), 12),
      auto: withDefault(Type.Enum(["off", "trim", "full"]), "off"),
      /** What a trim leaves out, as sizes in bytes (`reasoning`: all of it). */
      trim: section({
        tool_results: withDefault(Type.Integer({ minimum: 0 }), 2048),
        tool_args: withDefault(Type.Integer({ minimum: 0 }), 2048),
        reasoning: withDefault(Type.Boolean(), true),
      }),
      /** The model that writes summaries, of the thread's provider. Default: the thread's own model. */
      summary_model: opt(nonEmpty),
      /**
       * What the summarizer reads: `seen`, what the main model sees (past summaries and trimmed entries); or `raw`, the
       * entries since the last summary untrimmed (falls back to `seen` if that does not fit).
       */
      summary_input: withDefault(Type.Enum(["seen", "raw"]), "seen"),
      /**
       * The share of the threshold (at 3 bytes to a token) that the summaries in the context may take. While they fit, a
       * new summary covers only what came after them and they stay as they are (cache-friendly); beyond it, the new one
       * takes them in and covers everything.
       */
      summary_budget: withDefault(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }), 0.15),
    }),
  ),
});

export type HarnessConfig = StaticDecode<typeof harnessConfig>;
