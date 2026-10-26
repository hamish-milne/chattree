import type { Ctx, NamedDraft } from "../engine.ts";
import type { Output } from "../output.ts";
import type { Command } from "../registry.ts";
import { failure } from "../turn.ts";
import { sendMessage } from "./chat.ts";
import { editDraft, editText } from "./misc.ts";

/** Words `/draft` uses for the prompt draft; a named draft cannot take them. */
const RESERVED = ["show", "edit", "clear", "set"];

/** The smallest unused number: 1, 2, 3 ... (a sent or discarded draft frees its number). */
export function nextDraftName(drafts: readonly NamedDraft[]): string {
  const used = new Set(drafts.map((d) => d.name));
  let n = 1;
  while (used.has(String(n))) n++;
  return String(n);
}

const nameProblem = (name: string): string | undefined =>
  RESERVED.includes(name) ? `${name} is a /draft subcommand, so it cannot name a draft` : /^[^\s/]+$/.test(name) ? undefined : "a draft's name is one word without slashes";

const preview = (t: string): string => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 60)}…` : one;
};

async function* editNamed(ctx: Ctx, name: string): AsyncGenerator<Output, void> {
  const existing = ctx.state.drafts.find((d) => d.name === name);
  const text = await editText(ctx, `draft-${name}.md`, existing?.text ?? "");
  if (text === undefined) {
    yield { type: "error", message: "the editor did not exit cleanly; nothing was changed" };
    return;
  }
  if (text.trim() === "") {
    ctx.state.drafts = ctx.state.drafts.filter((d) => d.name !== name);
    yield { type: "notice", message: existing === undefined ? "nothing written, so no draft was made" : `draft ${name} is empty, so it was removed` };
    return;
  }
  ctx.state.drafts = existing === undefined ? [...ctx.state.drafts, { name, text }] : ctx.state.drafts.map((d) => (d.name === name ? { name, text } : d));
  yield { type: "notice", message: `${existing === undefined ? "saved" : "updated"} draft ${name}; /send ${name} sends it` };
}

const draft: Command = {
  name: "draft",
  summary: "write a message ahead in your editor (named drafts), or work with the unsent prompt",
  usage: "/draft [name]  opens a named draft in the editor (no name: a new numbered one)\n/draft show | edit | clear | set <text>  work on the prompt you are typing",
  busy: "allowed",
  stages: { show: "drafts", clear: "discard" },
  async complete(ctx, previous, partial) {
    return previous.length > 0 ? [] : [...RESERVED, ...ctx.state.drafts.map((d) => d.name)].filter((n) => n.startsWith(partial));
  },
  async *run(ctx, args, rest) {
    try {
      const sub = args[0];
      if (sub === "clear") {
        ctx.state.draft = "";
        yield { type: "notice", message: "draft cleared" };
      } else if (sub === "set") {
        ctx.state.draft = rest.replace(/^\s*set\s*/, "");
        yield { type: "notice", message: "draft replaced" };
      } else if (sub === "edit") yield* editDraft(ctx);
      else if (sub === "show") yield { type: "text", text: ctx.state.draft === "" ? "(the draft is empty)" : ctx.state.draft };
      else {
        if (args.length > 1) {
          yield { type: "error", message: "a draft's name is one word", hint: "/draft [name]" };
          return;
        }
        const name = sub ?? nextDraftName(ctx.state.drafts);
        const problem = nameProblem(name);
        if (problem !== undefined) {
          yield { type: "error", message: problem };
          return;
        }
        yield* editNamed(ctx, name);
      }
    } catch (e) {
      yield failure(e);
    }
  },
};

const drafts: Command = {
  name: "drafts",
  summary: "list the named drafts",
  usage: "/drafts",
  busy: "allowed",
  async *run(ctx) {
    yield { type: "text", text: ctx.state.drafts.length === 0 ? "no named drafts (/draft [name] writes one)" : ctx.state.drafts.map((d) => `${d.name}  ${d.text.length} characters  ${preview(d.text)}`).join("\n") };
  },
};

const discard: Command = {
  name: "discard",
  summary: "remove a named draft (or all of them) without sending",
  usage: "/discard <name | all>",
  busy: "allowed",
  async complete(ctx, previous, partial) {
    return previous.length > 0 ? [] : ["all", ...ctx.state.drafts.map((d) => d.name)].filter((n) => n.startsWith(partial));
  },
  async *run(ctx, args) {
    const which = args[0];
    if (which === undefined) {
      yield { type: "error", message: "say which draft, or all", hint: "/discard <name | all>; see /drafts" };
      return;
    }
    const before = ctx.state.drafts.length;
    ctx.state.drafts = which === "all" ? [] : ctx.state.drafts.filter((d) => d.name !== which);
    const n = before - ctx.state.drafts.length;
    yield n === 0 ? { type: "error", message: `there is no draft ${which}` } : { type: "notice", message: `removed ${n} draft${n === 1 ? "" : "s"}` };
  },
};

const send: Command = {
  name: "send",
  summary: "send a named draft (with the staged files) and remove it from the list",
  usage: "/send [name]  (the name can be left out when there is only one draft)",
  busy: "blocked",
  async complete(ctx, previous, partial) {
    return previous.length > 0 ? [] : ctx.state.drafts.map((d) => d.name).filter((n) => n.startsWith(partial));
  },
  async *run(ctx, args) {
    const name = args[0] ?? (ctx.state.drafts.length === 1 ? ctx.state.drafts[0]?.name : undefined);
    if (name === undefined) {
      yield { type: "error", message: ctx.state.drafts.length === 0 ? "there are no named drafts" : "say which draft", hint: ctx.state.drafts.length === 0 ? "/draft [name] writes one" : `/send <name>; see /drafts` };
      return;
    }
    const d = ctx.state.drafts.find((x) => x.name === name);
    if (d === undefined) {
      yield { type: "error", message: `there is no draft ${name}`, hint: "see /drafts" };
      return;
    }
    yield* sendMessage(ctx, d.text.trim(), () => {
      ctx.state.drafts = ctx.state.drafts.filter((x) => x.name !== name);
    });
  },
};

export const draftCommands: Command[] = [draft, drafts, discard, send];
