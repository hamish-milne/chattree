import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Conversation, ConversationError } from "../harness/conversation.ts";
import { envSource } from "../harness/secrets.ts";
import { defaultRegistry } from "../providers/index.ts";
import { Git } from "../src/index.ts";
import { CliError, type Io } from "./io.ts";

export interface InitOptions {
  dir?: string | undefined;
  provider?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  maxOutput?: number | undefined;
  keyEnv?: string | undefined;
  branch?: string | undefined;
  adopt?: boolean | undefined;
  force?: boolean | undefined;
  yes?: boolean | undefined;
}

const DEFAULT_MODEL: Record<string, string> = { anthropic: "claude-sonnet-5-5", openai: "gpt-6.1-sol" };
const KEY_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

export interface InitResult {
  root: string;
  branch: string;
  provider: string;
  model: string;
  pinned: boolean;
  notes: string[];
}

/** Which provider to configure: the flag, else the one whose key is in the environment, else ask (or fail saying how to choose). */
async function chooseProvider(io: Io, o: InitOptions): Promise<string> {
  if (o.provider !== undefined) {
    if (!["anthropic", "openai", "compatible"].includes(o.provider)) throw new CliError(`${o.provider} is not a provider this CLI sets up`, "use anthropic, openai or compatible (an OpenAI-compatible server such as Ollama or llama.cpp)");
    return o.provider;
  }
  const have = ["anthropic", "openai"].filter((p) => (io.env[KEY_ENV[p] as string] ?? "") !== "");
  if (have.length === 1) return have[0] as string;
  if (io.interactive && o.yes !== true && io.ask !== undefined) {
    const a = await io.ask("Which provider (anthropic, openai, compatible)?", have[0] ?? "anthropic");
    return chooseProvider(io, { ...o, provider: a });
  }
  throw new CliError(have.length === 0 ? "no provider chosen, and neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set" : "both ANTHROPIC_API_KEY and OPENAI_API_KEY are set; choose one", "pass --provider anthropic | openai | compatible (with --base-url and --model)");
}

function configText(provider: string, o: { baseUrl?: string; keyEnv?: string; windows?: boolean }): { text: string; name: string } {
  const lines = ["# chattree configuration: the outside world (providers, limits). The agent's own setup (model, settings, instructions) is in the transcript.", "providers:"];
  let name = provider;
  if (provider === "compatible") {
    name = "local";
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(o.baseUrl ?? "");
    lines.push("  local:", "    $tag: openai-compatible", `    base_url: ${o.baseUrl}`);
    if (o.keyEnv !== undefined) lines.push(`    api_key_env: ${o.keyEnv}`);
    if (local) lines.push("    pricing: { free: true }");
  } else lines.push(`  ${provider}:`, `    $tag: ${provider}`, `    api_key_env: ${o.keyEnv ?? KEY_ENV[provider]}`);
  lines.push("limits:", "  max_request_usd: 1", "  max_turn_usd: 5", "  max_conversation_usd: 50", "  warn_at: 0.8");
  lines.push(
    "# Approvals: a tool call runs without asking only while a key here covers it (key: until). `all` covers every call of the tool;",
    "# anything else asks, and the answer can add a key. `safe` lists commands known to be read-only, offered as `<command> **`.",
    "# Only the tools listed here are offered to the model: delete an entry to turn that tool off.",
    "tools:",
    "  read:",
    "    allow: { all: 2999-01-01 }",
    "  write:",
    "    allow: { all: 2999-01-01 }",
    "  edit:",
    "    allow: { all: 2999-01-01 }",
    "  jobs:",
    "    allow: { all: 2999-01-01 }",
    "  job_output:",
    "    allow: { all: 2999-01-01 }",
    "  job_stop:",
    "    allow: { all: 2999-01-01 }",
    "  script:",
    "    allow: {}",
    "  subagent:",
    "    allow: {}",
    "  run:",
    "    safe: [cat, grep, head, tail, wc, ls, diff, git status, git diff, git log]",
    ...(o.windows === true ? ["    # Windows: lets run start .cmd programs such as npm and pnpm through cmd.exe, which re-reads their arguments; arguments with its", "    # special characters are refused. Programs inside the workspace (node_modules\\.bin) also need a glob in `local`.", "    batch: true"] : []),
    "",
  );
  return { text: lines.join("\n"), name };
}

/**
 * `chattree init`: start a conversation. In a directory that is not inside a git repository it makes one. Inside a repository it
 * refuses unless told how: `adopt` puts the conversation on the branch that is checked out (every entry then also commits the
 * working tree's pending changes, which is how snapshots work), `force` makes a new, nested repository in the directory.
 */
export async function runInit(io: Io, o: InitOptions): Promise<InitResult> {
  const dir = resolve(io.cwd, o.dir ?? ".");
  await io.host.fs.mkdir(dir);
  const probe = await Git.open(io.host, { cwd: dir });
  const top = await probe.run(["rev-parse", "--show-toplevel"], { ok: [128], readOnly: true });
  const inRepo = top.exitCode === 0 ? new TextDecoder().decode(top.stdout).trim() : undefined;
  if (o.adopt === true && o.force === true) throw new CliError("--adopt and --force are different things; choose one");
  if (inRepo !== undefined && o.adopt !== true && o.force !== true) {
    throw new CliError(
      `${dir} is inside the git repository ${inRepo}`,
      "a conversation shares its branch, and every entry commits the working tree's pending changes with it (that is how snapshots and rollback work). `--adopt` accepts that and starts on the checked-out branch of the repository; `--force` makes a separate, nested repository in this directory",
    );
  }
  if (inRepo === undefined && o.adopt === true) throw new CliError(`${dir} is not inside a git repository, so there is nothing to adopt`, "drop --adopt to create one");

  const provider = await chooseProvider(io, o);
  if (provider === "compatible" && o.baseUrl === undefined) throw new CliError("an OpenAI-compatible provider needs its address", "pass --base-url http://localhost:11434/v1 (the address of the server, including /v1)");
  const model = o.model ?? DEFAULT_MODEL[provider];
  if (model === undefined) throw new CliError("an OpenAI-compatible provider needs a model name", "pass --model <name>, as the server calls it");
  const cfg = configText(provider, { ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }), ...(o.keyEnv === undefined ? {} : { keyEnv: o.keyEnv }), windows: io.host.platform === "windows" });

  // The providers are built to check the configuration and to price the setup. A key that is not exported yet must not stop init, so
  // a variable that is missing gets a placeholder here; it exists only for this call and is never written anywhere.
  const env: Record<string, string | undefined> = { ...io.env };
  const keyVar = o.keyEnv ?? KEY_ENV[provider];
  const notes: string[] = [];
  if (keyVar !== undefined && (env[keyVar] ?? "") === "") {
    env[keyVar] = `init-placeholder-${randomBytes(8).toString("hex")}`;
    notes.push(`${keyVar} is not set; set it before you chat`);
  }
  const opts = { now: io.now, providers: { registry: defaultRegistry(), secrets: envSource(env) }, config: cfg.text, ...(o.branch === undefined ? {} : { branch: o.branch }) };
  let convo: Conversation;
  try {
    convo = o.adopt === true ? await Conversation.adopt(io.host, inRepo as string, opts) : await Conversation.create(io.host, dir, opts);
  } catch (e) {
    if (e instanceof ConversationError) throw new CliError(e.message);
    throw e;
  }
  await convo.setupChange({ model: { provider: cfg.name, id: model, settings: { max_output_tokens: o.maxOutput ?? 8192 } } });
  let pinned = false;
  try {
    await convo.pinPricing();
    pinned = true;
  } catch (e) {
    notes.push(`could not pin prices (${e instanceof Error ? e.message : String(e)}); run /pricing pin later`);
  }
  return { root: convo.dir, branch: convo.branch, provider: cfg.name, model, pinned, notes };
}
