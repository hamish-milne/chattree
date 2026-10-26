import type { ChatEntry } from "../../harness/entries.ts";
import { recentEntries } from "../recent.ts";
import type { Command } from "../registry.ts";
import { failure } from "../turn.ts";
import { nextDraftName } from "./drafts.ts";

const undo: Command = {
  name: "undo",
  summary: "take the thread back n commits (default: to just before your last message) and put that message in a draft",
  usage: "/undo [n]",
  busy: "blocked",
  async *run(ctx, args) {
    const { convo, engine } = ctx;
    try {
      if (args.length > 1 || (args[0] !== undefined && !/^[1-9]\d*$/.test(args[0]))) {
        yield { type: "error", message: `${args.join(" ")} is not a number of commits`, hint: "/undo [n]" };
        return;
      }
      const refs = await convo.index();
      const head = await convo.git.head();
      if (head === undefined) {
        yield { type: "error", message: "the thread has no commits" };
        return;
      }
      let rev: string;
      if (args[0] === undefined) {
        const lastUser = [...refs].reverse().find((r) => r.tag === "user");
        if (lastUser === undefined) {
          yield { type: "error", message: "there is no message of yours to undo", hint: "/undo <n> goes back a number of commits" };
          return;
        }
        rev = `${lastUser.commit}^`;
      } else rev = `${head}~${args[0]}`;
      const to = await convo.git.revParse(rev);
      if (to === undefined) {
        yield { type: "error", message: `the thread is not ${args[0] ?? "that many"} commits long`, hint: "/log shows its commits" };
        return;
      }
      const [tip] = await convo.git.log(to, { maxCount: 1 });
      const offset = Number(tip?.trailers["Chattree-Offset"]?.[0]);
      const dropped = refs.filter((r) => r.offset > offset);
      const count = Number((await convo.git.text(["rev-list", "--count", `${to}..${head}`], { readOnly: true })).trim());

      const byId = new Map<string, ChatEntry>();
      for (const e of await convo.readEntries()) if (e.ok && "id" in e.value) byId.set(e.value.id, e.value);
      const firstUser = dropped.filter((r) => r.tag === "user").map((r) => (r.id === undefined ? undefined : byId.get(r.id))).find((e): e is Extract<ChatEntry, { $tag: "user" }> => e?.$tag === "user");
      let text = "";
      const lostFiles: string[] = [];
      if (firstUser !== undefined) {
        for (const p of firstUser.content) {
          if (p.$tag === "text") text += typeof p.text === "string" ? p.text : new TextDecoder().decode((await convo.store.get(p.text.sha256)) ?? new Uint8Array());
          else lostFiles.push(p.name ?? p.data.sha256.slice(0, 8));
        }
      }

      const kinds = new Map<string, number>();
      for (const r of dropped) kinds.set(r.tag, (kinds.get(r.tag) ?? 0) + 1);
      const others = engine.sessions === undefined ? [] : (await engine.sessions.list()).filter((s) => s.thread === engine.thread && s.locked && s.id !== engine.sessionId);
      yield {
        type: "notice",
        message: [
          `this takes ${engine.thread} back ${count} commit${count === 1 ? "" : "s"}, dropping ${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ") || "no entries"}; the workspace files go back with it${firstUser === undefined ? "" : `; your message "${text.replace(/\s+/g, " ").trim().slice(0, 50)}${text.length > 50 ? "…" : ""}" goes into a draft`}`,
          ...(lostFiles.length > 0 ? [`its attached files (${lostFiles.join(", ")}) are not carried into the draft; /attach them again`] : []),
          ...(others.length > 0 ? [`${others.length} other session${others.length === 1 ? " is" : "s are"} on this thread and will need to be restarted`] : []),
        ].join("\n"),
      };
      if (!(await ctx.confirm("Go back?"))) {
        yield { type: "notice", message: "nothing was changed" };
        return;
      }
      const r = await convo.rewind(to);
      if (firstUser !== undefined && text.trim() !== "") {
        if (ctx.state.draft.trim() === "") ctx.state.draft = text;
        else {
          const name = nextDraftName(ctx.state.drafts);
          ctx.state.drafts = [...ctx.state.drafts, { name, text }];
          yield { type: "notice", message: `you already had a draft in progress, so the message is saved as draft ${name} (/draft ${name} edits it, /send ${name} sends it)` };
        }
      }
      yield { type: "notice", message: `done. The tip was ${r.from}; to bring it back: git branch <name> ${r.from}  (also kept as ${r.ref})` };
      const recent = await recentEntries(engine);
      if (recent.length > 0) yield { type: "text", text: recent.join("\n") };
    } catch (e) {
      yield failure(e);
    }
  },
};

export const undoCommands: Command[] = [undo];
