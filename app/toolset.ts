/**
 * Builds the tools a session offers its model. The set is assembled from the built-in tools, the thread and job tools, and
 * the MCP servers the thread has accepted; `harness.yml` decides which of them are offered at all. The module also holds
 * the helpers that find busybox and ffmpeg for the host. The terminal's approval prompt is `cli/toolset.ts`.
 */
import type { Conversation } from "../harness/conversation.ts";
import { localOwner } from "./owner.ts";
import { JobRegistry, jobTools } from "../harness/jobs.ts";
import type { LoopEvent } from "../harness/loop.ts";
import { leafTools } from "../harness/starter/index.ts";
import { forkTool, mergeTool, type ForkDeps } from "../harness/fork-tools.ts";
import { ThreadRuns } from "../harness/runs.ts";
import { skillTool } from "../harness/skill-tool.ts";
import { subagentTool } from "../harness/subagent.ts";
import { searchTool } from "../harness/search-tool.ts";
import { threadTools } from "../harness/thread-tools.ts";
import { resolveSubagentModels } from "../harness/subagent-models.ts";
import { settingsProblems } from "../providers/index.ts";
import { providerRegistry } from "./providers.ts";
import type { McpPool } from "../harness/mcp/pool.ts";
import { McpServers, type McpDeps } from "../harness/mcp/servers.ts";
import { ToolRegistry } from "../harness/tools.ts";
import { BUSYBOX_HINT, BusyboxError, ensureBusybox } from "../hosts/busybox.ts";
import { FfmpegError, ensureFfmpeg } from "../hosts/ffmpeg.ts";
import type { Converter } from "../harness/converter.ts";
import { ffmpegConverter } from "../harness/ffmpeg-converter.ts";
import { findBusybox } from "../hosts/node.ts";
import { AppError } from "./errors.ts";
import type { AppEnv } from "./env.ts";

/** The tools a session offers its model and the jobs they start, built from `harness.yml` (`tools.env`, `tools.run.safe`, `background.resume`). */
export interface ToolSet {
  registry: ToolRegistry;
  jobs: JobRegistry;
  /** The loops running for this thread's tools (a fork that works by itself). Subagents' loops are the pump's. */
  runs: ThreadRuns;
  /** What a subagent works with, before its own `merge` tool is added (`subagentChildRegistry`). */
  childRegistry: ToolRegistry;
  /** Whether the user reads a subagent's report before it is merged (`subagent.merge`). */
  merge: "auto" | "review";
  /** `background.resume`: a request is sent when something ended while idle. */
  resume: boolean;
  /** The MCP servers this thread has accepted and could reach, with the state of every server `harness.yml` names; their tools are in `registry`. */
  mcp: McpServers;
  /** Close the MCP servers and connect again (after the thread accepted one, or the configuration changed), keeping everything else running. Only between loops. */
  reloadMcp(): Promise<McpServers>;
}

export interface ToolSetHooks {
  /** A job's event was committed while nothing was running: tell the user. */
  onCommitted(this: void, events: { job: string; status: string; summary: string }[]): void;
  /** `background.resume` is on and an event was committed while idle: send a request. */
  onResume(this: void): void;
  /** A request of this session is running. */
  busy(this: void): boolean;
  /** This session's id, named as the holder of the run lease a background job takes. */
  session?: string;
  /** What a subagent's loop does, for showing the user. */
  onChildEvent?(name: string, event: LoopEvent): void;
  /** A fork of this thread, made where the project keeps worktrees. */
  createFork?: ForkDeps["createFork"];
  /** The first message the model gave a fork it made. */
  onForkDraft?: ForkDeps["onDraft"];
  /** The process's MCP connections, shared with the subagents and the other threads (`McpPool`). Without it the set connects by itself. */
  mcpPool?: McpPool;
  /** The project's main directory, where an MCP server with `scope: project` starts. */
  projectDir?: string;
  /** Threads are pumped here (`Engine.pump`): the model may start subagents, and forks that run by themselves. */
  pumped?: boolean;
}

/**
 * The busybox.exe `run` uses on Windows, or undefined elsewhere. The `busybox` setting (settings file) is `auto` (default: the one that is there, else
 * the pinned release is fetched), `off` (use one that is there, never fetch) or the path of a busybox.exe. Failing to get one is the
 * user's problem, not the model's, so it is a AppError raised before anything is sent.
 */
export async function resolveBusybox(
  io: AppEnv,
  mode: string | undefined,
  ensure: typeof ensureBusybox = ensureBusybox,
): Promise<string | undefined> {
  if (io.host.platform !== "windows") return undefined;
  const how = mode ?? "auto";
  if (how === "off") return findBusybox(io.env);
  if (how !== "auto") {
    if ((await io.host.fs.stat(how))?.isFile !== true) throw new AppError(`busybox is ${how}, which is not a file`, BUSYBOX_HINT);
    return how;
  }
  try {
    return await ensure({ env: io.env, say: (m) => io.err?.(`${m}\n`) });
  } catch (e) {
    if (e instanceof BusyboxError) throw new AppError(e.message, e.hint);
    throw e;
  }
}

/** The busybox.exe for this thread's configuration (fetched on first use when the `busybox` setting is auto), or undefined off Windows. */
export async function busyboxFor(io: AppEnv): Promise<string | undefined> {
  return resolveBusybox(io, io.settings?.busybox);
}

/**
 * The ffmpeg that converts pictures and sound, or undefined when the `ffmpeg` setting is `false` (never convert). There is no default: an
 * unset key is an error here, at the moment a conversion is needed, because what the user means (fetch one? use mine? never?) is not known.
 * `auto` uses the one that is there (CHATTREE_FFMPEG, the PATH) and on Windows fetches the pinned build; a path must be a file.
 */
export async function resolveFfmpeg(
  io: AppEnv,
  setting: false | string | undefined,
  ensure: typeof ensureFfmpeg = ensureFfmpeg,
): Promise<string | undefined> {
  if (setting === undefined)
    throw new AppError(
      "a picture or sound has to be converted for this model, and the ffmpeg setting is not set",
      "add `ffmpeg: auto` (or a path to ffmpeg, or `false` to never convert) to the settings file: `chattree settings edit`",
    );
  if (setting === false) return undefined;
  if (setting !== "auto") {
    if ((await io.host.fs.stat(setting))?.isFile !== true)
      throw new AppError(`ffmpeg is ${setting}, which is not a file`, "fix the ffmpeg setting (`chattree settings edit`)");
    return setting;
  }
  try {
    return await ensure({ env: io.env, flite: false, say: (m) => io.err?.(`${m}\n`) });
  } catch (e) {
    if (e instanceof FfmpegError) throw new AppError(e.message, e.hint);
    throw e;
  }
}

/** The ffmpeg for this session's settings (see `resolveFfmpeg`). */
export const ffmpegFor = (io: AppEnv): Promise<string | undefined> => resolveFfmpeg(io, io.settings?.ffmpeg);

/** What starting an MCP server needs from this session. */
export const mcpDeps = (io: AppEnv, convo: Conversation, projectDir: string | undefined): McpDeps => ({
  host: io.host,
  cwd: convo.dir,
  env: io.env,
  ...(projectDir === undefined ? {} : { projectDir }),
});

export async function buildToolSet(io: AppEnv, convo: Conversation, hooks: ToolSetHooks): Promise<ToolSet> {
  const cfg = await convo.readConfig();
  const config = cfg?.ok === true ? cfg.value : undefined;
  const env = config?.tools.env ?? [];
  const jobs = new JobRegistry(convo, {
    owner: localOwner(hooks.session),
    resume: config?.background.resume === true,
    onCommitted: hooks.onCommitted,
    onResume: hooks.onResume,
    busy: hooks.busy,
  });
  const safe = config?.tools["run"]?.safe ?? [];
  // Only tools listed under `tools` in harness.yml are offered; leaving one out turns it off.
  const listed = (name: string): boolean => config?.tools[name] !== undefined;
  // busybox is fetched only when a shell tool is offered, so a thread without one never downloads it.
  const busybox = listed("run") || listed("script") ? await resolveBusybox(io, io.settings?.busybox) : undefined;
  const runs = new ThreadRuns();
  const leaf = [
    ...leafTools({
      busybox,
      env: { allow: env, values: io.env },
      safe,
      batch: config?.tools["run"]?.batch === true,
      git: config?.tools["run"]?.git === true,
      mmRead: listed("mm_read"),
      batchLocal: config?.tools["run"]?.local ?? [],
      hostEnv: io.env,
    }),
    skillTool(),
    ...threadTools({ convo, siblings: config?.threads.siblings === true }),
    searchTool({ convo }),
  ];
  // A subagent works with the leaf tools the thread has, and cannot start subagents of its own.
  const childRegistry = new ToolRegistry(leaf.filter((t) => listed(t.definition.name)));
  // The models the parent may choose for a subagent. A list that names a provider harness.yml does not have is the user's to fix.
  const chosen = resolveSubagentModels(config?.subagent.models, new Set(Object.keys(config?.providers ?? {})), (p, id) =>
    convo.modelInfo(p, id),
  );
  if (chosen.problems.length > 0)
    throw new AppError(chosen.problems.join("\n"), "fix subagent.models in harness.yml, or remove it to give subagents the parent's model");
  const adapters = providerRegistry(io);
  const validateSettings = async (provider: string, settings: unknown): Promise<string[]> => {
    const tag = (config?.providers[provider] as { $tag?: string } | undefined)?.$tag;
    const def = tag === undefined ? undefined : adapters.get(tag);
    if (def === undefined) return [`no adapter for provider ${provider}`];
    return settingsProblems(def, settings);
  };
  // The subagent tool needs the pump to run its loops, so it is offered only when the thread is pumped.
  const meta =
    hooks.pumped !== true
      ? []
      : [subagentTool({ convo, childRegistry, models: chosen.models, validateSettings, merge: config?.subagent.merge ?? "auto" })];
  const auto = hooks.createFork === undefined || hooks.pumped !== true ? undefined : { childRegistry };
  const forks =
    hooks.createFork === undefined
      ? []
      : [
          forkTool({
            convo,
            createFork: hooks.createFork,
            ...(auto === undefined ? {} : { auto }),
            ...(hooks.onForkDraft === undefined ? {} : { onDraft: hooks.onForkDraft }),
          }),
          mergeTool({ convo }),
        ];
  // MCP servers start only once the thread has accepted their configuration (a harness.yml can arrive with a cloned repository).
  const connect = async (fresh = false): Promise<McpServers> => {
    const now = await convo.readConfig();
    return McpServers.connect(
      now?.ok === true ? now.value.mcp : {},
      await convo.setup(),
      mcpDeps(io, convo, hooks.projectDir),
      hooks.mcpPool === undefined ? undefined : { pool: hooks.mcpPool, fresh },
    );
  };
  const mcp = await connect();
  const all = [...leaf, ...jobTools(jobs), ...meta, ...forks];
  const registry = new ToolRegistry([...all.filter((t) => listed(t.definition.name)), ...mcp.tools]);
  const set: ToolSet = {
    registry,
    jobs,
    runs,
    childRegistry,
    merge: config?.subagent.merge ?? "auto",
    resume: config?.background.resume === true,
    mcp,
    async reloadMcp() {
      const old = set.mcp;
      await old.close();
      for (const t of old.tools) registry.remove(t.definition.name);
      set.mcp = await connect(true);
      for (const t of set.mcp.tools) registry.add(t);
      return set.mcp;
    },
  };
  return set;
}

// Keyed by the Io, so each session shares one converter. A failed build is forgotten, so the next conversion tries again.
const converters = new WeakMap<AppEnv, Promise<Converter | undefined>>();

/**
 * What `prepareContext` takes to convert pictures and sound for this session: a converter asked for only when something needs converting
 * (so the `ffmpeg` setting is an error only then, and `false` means files that need converting become notes), made once per session.
 */
export function mediaFor(io: AppEnv, commonDir: () => Promise<string>): { converter: () => Promise<Converter | undefined> } {
  return {
    converter: () => {
      let c = converters.get(io);
      if (c === undefined) {
        c = (async () => {
          const ffmpeg = await ffmpegFor(io);
          if (ffmpeg === undefined) return undefined;
          return ffmpegConverter({ host: io.host, ffmpeg, workDir: io.host.path.join(await commonDir(), "chattree", "convert", "work") });
        })();
        converters.set(io, c);
        c.catch(() => converters.delete(io));
      }
      return c;
    },
  };
}
