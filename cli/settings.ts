import { z } from "zod";
import { editConfig, parseConfig } from "../src/config.ts";
import type { Host } from "../src/host.ts";
import { localModelsSchema } from "../localmodels/config.ts";
import { CliError, type Io } from "./io.ts";

/**
 * The user-level settings file (docs/cli.md): things that belong to the person and the machine, not to a thread, so they are not in
 * `harness.yml`. Read once at startup; a file that does not parse is an error, never silently ignored.
 */
export const settingsSchema = z
  .object({
    /** The editor command (it may carry arguments, "code -w"). Before `$VISUAL` and `$EDITOR`. */
    editor: z.string().min(1).optional(),
    /** Windows: where `run` gets cat, ls, grep and the rest. `auto` (the default) uses the busybox.exe that is there or fetches the pinned release, `off` never fetches, anything else is the path of a busybox.exe. */
    busybox: z.string().min(1).optional(),
    /**
     * Where ffmpeg comes from, which converts pictures and sound into a form a model takes (docs/tools.md, media formats). `auto`: the one that
     * is there (CHATTREE_FFMPEG, the PATH), else on Windows the pinned build is fetched; a path: that program; `false`: never convert. There is no
     * default: a conversion that is needed while this is not set is an error, since what was meant is not known. `chattree init` writes `auto`.
     */
    ffmpeg: z.union([z.literal(false), z.string().min(1)]).optional(),
    /** Where downloaded programs and models are kept. Default: the user data directory (`$XDG_DATA_HOME/chattree`, `%LOCALAPPDATA%\\chattree`). */
    data_dir: z.string().min(1).optional(),
    /** The models chattree downloads and runs itself (docs/local-models.md). */
    local_models: localModelsSchema.optional(),
    /** What new sessions show; `/display` changes it for one session. */
    display: z
      .object({
        thinking: z.enum(["on", "brief", "off"]).optional(),
        tools: z.enum(["full", "brief", "off"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;

/** Where the file is: `CHATTREE_SETTINGS`, else `chattree/settings.yml` under the user's config directory. Undefined when there is no way to tell. */
export function settingsPath(host: Host, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const set = env["CHATTREE_SETTINGS"];
  if (set !== undefined && set !== "") return host.path.resolve(set);
  const base = host.platform === "windows" ? env["APPDATA"] : (env["XDG_CONFIG_HOME"] ?? (env["HOME"] === undefined || env["HOME"] === "" ? undefined : host.path.join(env["HOME"], ".config")));
  return base === undefined || base === "" ? undefined : host.path.join(base, "chattree", "settings.yml");
}

/** The settings; empty when there is no file. A file that cannot be read or does not match the schema is a CliError naming it. */
export async function loadSettings(io: Pick<Io, "host" | "env">): Promise<Settings> {
  const path = settingsPath(io.host, io.env);
  if (path === undefined) return {};
  const bytes = await io.host.fs.read(path).catch(() => undefined);
  if (bytes === undefined) return {};
  const parsed = await parseConfig(new TextDecoder().decode(bytes), settingsSchema);
  if (!parsed.ok) {
    throw new CliError(`${path} is not valid:\n${parsed.issues.map((i) => `  ${i.path === "" ? "" : `${i.path}: `}${i.message}`).join("\n")}`, "fix it with `chattree settings edit`, or move it away");
  }
  return parsed.value;
}

const TEMPLATE = `# chattree settings (user level; thread settings are in harness.yml)
# editor: code -w
# busybox: auto        # auto | off | path to busybox.exe (Windows)
# ffmpeg: auto        # auto | false | path to ffmpeg: converts pictures and sound a model cannot take (written by \`chattree init\`)
# data_dir: ~/.local/share/chattree
# local_models:             # see docs/local-models.md
#   llama_cpp: { tag: b12110, backend: auto }
#   models:
#     qwen: { hf: "Qwen/Qwen3-8B-GGUF:Q4_K_M", ctx_size: 16384 }
# display:
#   thinking: brief    # on | brief | off
#   tools: brief       # full | brief | off
`;

/** The editor command: settings, then \`$VISUAL\`, then \`$EDITOR\`; undefined leaves the choice of a default to the host. */
export const editorFor = (io: Pick<Io, "env" | "settings">): string | undefined => io.settings?.editor ?? io.env["VISUAL"] ?? io.env["EDITOR"];

/** The file, created with a commented template when it is not there yet; the path to open. */
export async function ensureSettingsFile(io: Pick<Io, "host" | "env">): Promise<string> {
  const path = settingsPath(io.host, io.env);
  if (path === undefined) throw new CliError("there is no settings location on this machine", "set CHATTREE_SETTINGS to a file path");
  if ((await io.host.fs.stat(path)) === undefined) await io.host.fs.writeAtomic(path, new TextEncoder().encode(TEMPLATE));
  return path;
}

/**
 * Make sure the settings file says how to get ffmpeg: `ffmpeg: auto` is added when the key is missing (the file is created if there is none),
 * keeping the file's comments. Whatever the file already says is left alone. Returns the file and whether it was changed; undefined when
 * there is no place for a settings file, or when the file does not parse (the person has to fix that first, and is told then).
 */
export async function ensureFfmpegSetting(io: Pick<Io, "host" | "env">): Promise<{ path: string; changed: boolean } | undefined> {
  const path = settingsPath(io.host, io.env);
  if (path === undefined) return undefined;
  const bytes = await io.host.fs.read(path).catch(() => undefined);
  const text = bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  const write = (t: string) => io.host.fs.writeAtomic(path, new TextEncoder().encode(t));
  if (text === undefined || text.trim() === "") {
    await write(`${TEMPLATE}\nffmpeg: auto\n`);
    return { path, changed: true };
  }
  const edited = await editConfig(text, settingsSchema, (doc) => {
    if (!doc.has("ffmpeg")) doc.set("ffmpeg", "auto");
  });
  if (!edited.ok) return undefined;
  if (edited.text === text) return { path, changed: false };
  await write(edited.text);
  return { path, changed: true };
}
