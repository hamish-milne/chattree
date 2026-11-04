import { stringify } from "yaml";
import type { Io } from "../io.ts";
import type { Command } from "../registry.ts";
import { ensureSettingsFile, settingsPath } from "../settings.ts";

/** What the settings are now, as text: where the file is (or would be) and what it holds. */
export function describeSettings(io: Pick<Io, "host" | "env" | "settings">): string {
  const path = settingsPath(io.host, io.env);
  const body = io.settings === undefined || Object.keys(io.settings).length === 0 ? "(nothing set)" : stringify(io.settings).trimEnd();
  return `${path ?? "(no settings location: set CHATTREE_SETTINGS)"}\n${body}`;
}

const settings: Command = {
  name: "settings",
  summary: "show the user-level settings file, or open it in the editor",
  usage: "/settings  |  /settings edit   (changes apply the next time chattree starts)",
  busy: "allowed",
  async complete(_ctx, previous, partial) {
    return previous.length === 0 ? ["edit"].filter((f) => f.startsWith(partial)) : [];
  },
  async *run(ctx, args) {
    if (args.length === 0) {
      yield { type: "text", text: describeSettings(ctx.io) };
      return;
    }
    if (args[0] !== "edit" || args.length > 1) {
      yield { type: "error", message: `${args.join(" ")} is not understood`, hint: "/settings  |  /settings edit" };
      return;
    }
    const path = await ensureSettingsFile(ctx.io);
    if (!(await ctx.engine.edit(path))) {
      yield { type: "error", message: "the editor did not exit cleanly" };
      return;
    }
    yield { type: "notice", message: `${path} saved; changes apply the next time chattree starts` };
  },
};

export const settingsCommands: Command[] = [settings];
