/**
 * One agent task through the real loop in a fresh temporary workspace, for the live checks and the sampler. Never
 * throws for a model's failure (wrong files, a loop that ended early): the caller scores the outcome.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BusyboxError, ensureBusybox } from "../hosts/busybox.ts";
import { nodeHost } from "../hosts/node.ts";
import type { ModelContext } from "../harness/context-builder.ts";
import type { HostEnvironment } from "../harness/environment.ts";
import { Conversation } from "../harness/conversation.ts";
import { runLoop, syncTools } from "../harness/loop.ts";
import { envSource } from "../harness/secrets.ts";
import type { AgentSetup } from "../harness/setup.ts";
import { leafTools } from "../harness/starter/index.ts";
import { ToolRegistry, type Tool } from "../harness/tools.ts";
import { verifyHistory } from "../harness/verify.ts";
import type { StreamRun } from "../providers/conformance.ts";
import { AdapterRegistry, defineAdapter } from "../providers/registry.ts";
import type { ProviderAdapter } from "../providers/types.ts";

/** Passes a stream through unchanged and reports each request's events to `report` when it ends, however it ends. */
export function recording(inner: ProviderAdapter, report: (run: StreamRun, c: ModelContext) => void | Promise<void>): ProviderAdapter {
  return {
    ...inner,
    stream(req) {
      const events: StreamRun["events"] = [];
      const source = inner.stream(req);
      return (async function* () {
        const run: StreamRun = { events };
        try {
          for (;;) {
            const n = await source.next();
            if (n.done === true) {
              run.completed = n.value;
              return n.value;
            }
            events.push(n.value);
            yield n.value;
          }
        } catch (e) {
          run.error = e;
          throw e;
        } finally {
          await report(run, req.context);
        }
      })();
    },
  };
}

export interface ToolStep {
  name: string;
  args: unknown;
  /** Undefined while running (a call whose result never arrived). */
  result?: string;
  is_error?: boolean;
}

export interface AgentTaskOptions {
  adapter: ProviderAdapter;
  model: NonNullable<AgentSetup["model"]>;
  files: Record<string, string>;
  prompt: string;
  system?: string;
  /** busybox.exe for the everyday utilities on Windows (see tools/fetch-busybox.ts). */
  busybox?: string | undefined;
  /** Wall-clock limit for the whole task. Default 180 s. */
  timeoutMs?: number;
  /** Starter tools to leave out, by name. */
  without?: readonly string[] | undefined;
  /** Tools offered besides the starter ones. */
  extraTools?: readonly Tool[] | undefined;
  /** Tells the model the date and where it is, as a session does (the `environment` injection). */
  environment?: HostEnvironment | undefined;
  /** Called with each request's raw run, for recording. */
  onRequest?: (run: StreamRun, context: ModelContext) => void | Promise<void>;
}

export interface AgentTaskResult {
  /** The workspace (left on disk). */
  dir: string;
  /** How the loop ended: completed, stopped (time), deadline, interrupted, cancelled, or `error: ...`. */
  status: string;
  requests: number;
  steps: ToolStep[];
  used: Set<string>;
  /** Tool results that were errors. */
  errors: number;
  /** The files named in `files` as they are at the end. */
  after: Record<string, string>;
  /** Every file in the workspace root at the end, for tasks that create files. */
  read: (name: string) => Promise<string | undefined>;
  /** What the model said last. */
  answer: string;
  /** What is wrong with the history, if anything (always empty unless the harness is broken). */
  problems: unknown[];
}

export const AGENT_SYSTEM = "You are a terse coding agent working in a workspace. Use the tools; do not guess file contents.";

export async function runAgentTask(o: AgentTaskOptions): Promise<AgentTaskResult> {
  const registry = new ToolRegistry([...leafTools({ busybox: o.busybox }).filter((t) => !(o.without ?? []).includes(t.definition.name)), ...(o.extraTools ?? [])]);
  const live = new AdapterRegistry().register(
    defineAdapter({
      $tag: "live",
      config: z.strictObject({ $tag: z.literal("live") }),
      settings: z.looseObject({}),
      jsonSchema: () => ({ config: { type: "object" }, settings: { type: "object" } }),
      secrets: () => [],
      create: () => (o.onRequest === undefined ? o.adapter : recording(o.adapter, o.onRequest)),
    }),
  );
  const dir = join(await mkdtemp(join(tmpdir(), "chattree-live-")), "c");
  const convo = await Conversation.create(nodeHost(), dir, { providers: { registry: live, secrets: envSource({}) }, config: "providers:\n  live:\n    $tag: live\n" });
  await convo.setupChange({ model: o.model });
  await syncTools(convo, registry);
  for (const [name, text] of Object.entries(o.files)) await writeFile(join(dir, name), text);
  await convo.append({ $tag: "user", content: [{ $tag: "text", text: o.prompt }] });

  const steps: ToolStep[] = [];
  const used = new Set<string>();
  let errors = 0;
  let status = "";
  let requests = 0;
  try {
    const gen = runLoop(convo, { system: o.system ?? AGENT_SYSTEM, cost: false, registry, environment: o.environment, signal: AbortSignal.timeout(o.timeoutMs ?? 180_000) });
    for (;;) {
      const n = await gen.next();
      if (n.done === true) {
        status = n.value.status;
        requests = n.value.requests;
        break;
      }
      const e = n.value;
      if (e.type === "tool.start") {
        used.add(e.name);
        steps.push({ name: e.name, args: e.args });
      } else if (e.type === "tool.result") {
        const step = steps.findLast((s) => s.result === undefined);
        if (step !== undefined) {
          step.result = e.content;
          step.is_error = e.is_error;
        }
        if (e.is_error) errors++;
      }
    }
  } catch (e) {
    status = `error: ${e instanceof Error ? e.message : String(e)}`;
  }
  const read = (name: string): Promise<string | undefined> => readFile(join(dir, name), "utf8").catch(() => undefined);
  const after: Record<string, string> = {};
  for (const name of Object.keys(o.files)) after[name] = (await read(name)) ?? "";
  const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  const lastAssistant = entries.findLast((e) => e.$tag === "assistant");
  const answer = lastAssistant?.$tag === "assistant" ? lastAssistant.blocks.flatMap((b) => (b.$tag === "text" ? [b.text] : [])).join("") : "";
  const problems = await verifyHistory(convo).catch((e: unknown) => [String(e)]);
  return { dir, status, requests, steps, used, errors, after, read, answer, problems };
}

/** The facts a session would give the model about this machine, for tasks that depend on them. */
export function benchEnvironment(busybox?: string): HostEnvironment {
  const windows = process.platform === "win32";
  return {
    os: windows ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux",
    platform: windows ? "windows" : "posix",
    utilities: windows && busybox !== undefined ? "`run` takes one command or pipeline in a bash-like syntax, with busybox utilities and the programs on the PATH; `script` runs a POSIX sh script with busybox." : "`run` takes one command or pipeline in a bash-like syntax, using this machine's own utilities and programs; `script` runs a POSIX sh script.",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/**
 * The busybox.exe the `run` tool needs on Windows (undefined elsewhere): the one given, else the one that is there, else the pinned release,
 * fetched as chattree does on first use. A sampler that went on without it would measure the missing utilities, not the model, so failing
 * to get one ends the run at once.
 */
export async function requireBusybox(given?: string): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  if (given !== undefined) return given;
  try {
    return await ensureBusybox({ say: (m) => console.error(m) });
  } catch (e) {
    if (e instanceof BusyboxError) throw new Error(`${e.message}\n${e.hint ?? ""}`.trim());
    throw e;
  }
}
