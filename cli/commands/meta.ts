import type { Command } from "../registry.ts";

const help: Command = {
  name: "help",
  aliases: ["?"],
  summary: "list the commands, or explain one",
  usage: "/help [command]",
  busy: "allowed",
  async *run(ctx, args) {
    const want = args[0]?.replace(/^\//, "");
    if (want !== undefined) {
      const c = ctx.engine.registry.find(want);
      yield c === undefined ? { type: "error", message: `there is no command /${want}` } : { type: "text", text: `${c.usage}\n${c.summary}${c.busy === "blocked" ? "\n(not available while a request is running)" : ""}${c.aliases === undefined ? "" : `\naliases: ${c.aliases.map((a) => `/${a}`).join(", ")}`}` };
      return;
    }
    const w = Math.max(...ctx.engine.registry.commands.map((c) => c.name.length));
    yield { type: "text", text: `${ctx.engine.registry.commands.map((c) => `/${c.name.padEnd(w)}  ${c.summary}`).join("\n")}\n\nText that does not start with / is sent as a message.` };
  },
};

const quit: Command = {
  name: "quit",
  aliases: ["exit"],
  summary: "leave the session (nothing is lost: drafts and staged files are kept)",
  usage: "/quit",
  busy: "allowed",
  async *run(ctx) {
    ctx.engine.quit = true;
    yield { type: "notice", message: "bye" };
  },
};

export const metaCommands: Command[] = [help, quit];
