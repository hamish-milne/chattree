import type { Command } from "../registry.ts";
import { ago } from "./read.ts";

const sessions: Command = {
  name: "sessions",
  summary: "list this project's saved sessions",
  usage: "/sessions",
  busy: "allowed",
  async *run(ctx) {
    const store = ctx.engine.sessions;
    if (store === undefined) {
      yield { type: "error", message: "sessions are not available here" };
      return;
    }
    const all = await store.list();
    if (all.length === 0) {
      yield { type: "text", text: "no saved sessions (a session is kept when it ends with a draft or staged files)" };
      return;
    }
    const now = ctx.io.now();
    const rows = all.map((s) => {
      const mark = s.id === ctx.engine.sessionId ? "*" : " ";
      if (s.error !== undefined) return `${mark} ${s.id}  unreadable: ${s.error}`;
      const pending = [s.draft === true ? "draft" : "", s.attachments === undefined || s.attachments === 0 ? "" : `${s.attachments} file${s.attachments === 1 ? "" : "s"}`].filter((x) => x !== "").join(", ");
      const who = s.id === ctx.engine.sessionId ? "this session" : s.locked ? "in use" : "";
      return `${mark} ${s.id}  ${(s.thread ?? "").padEnd(16)} ${ago(s.updated ?? "", now).padEnd(8)} ${[pending, who].filter((x) => x !== "").join("  ")}`.trimEnd();
    });
    yield { type: "text", text: rows.join("\n") };
  },
};

export const sessionCommands: Command[] = [sessions];
