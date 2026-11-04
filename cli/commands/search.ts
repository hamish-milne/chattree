import { parseArgs } from "node:util";
import { search, SearchError, type Scope } from "../../harness/search.ts";
import type { Command } from "../registry.ts";

const SCOPES = ["thread", "family", "project"];

const searchCommand: Command = {
  name: "search",
  summary: "search this conversation's history for words or a pattern (this thread by default)",
  usage: "/search <words or \"a phrase\"> [--scope thread|family|project] [--regex] [--visible] [--reasoning] [--limit n]\n(--visible includes what the model sees now; /show thread:id opens a hit)",
  busy: "allowed",
  async complete(_ctx, previous, partial) {
    if (previous.at(-1) === "--scope") return SCOPES.filter((s) => s.startsWith(partial));
    return partial.startsWith("-") ? ["--scope", "--regex", "--visible", "--reasoning", "--limit"].filter((f) => f.startsWith(partial)) : [];
  },
  async *run(ctx, args) {
    let parsed;
    try {
      parsed = parseArgs({ args, allowPositionals: true, options: { scope: { type: "string" }, regex: { type: "boolean" }, visible: { type: "boolean" }, reasoning: { type: "boolean" }, limit: { type: "string" } } });
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : String(e), hint: "/search <query> [--scope thread|family|project] [--regex] [--visible] [--reasoning] [--limit n]" };
      return;
    }
    const { values, positionals } = parsed;
    if (values.scope !== undefined && !SCOPES.includes(values.scope)) {
      yield { type: "error", message: `--scope takes thread, family or project, not ${values.scope}` };
      return;
    }
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 50)) {
      yield { type: "error", message: "--limit takes a number from 1 to 50" };
      return;
    }
    // A quoted phrase arrives as one word: keep its quotes so it is still a phrase.
    const query = values.regex === true ? positionals.join(" ") : positionals.map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(" ");
    if (query.trim() === "") {
      yield { type: "error", message: "give something to search for", hint: "/search <words>" };
      return;
    }
    try {
      const r = await search(ctx.convo, ctx.convo.branch, {
        query,
        scope: (values.scope ?? "thread") as Scope,
        regex: values.regex === true,
        includeVisible: values.visible === true,
        reasoning: values.reasoning === true,
        ...(limit === undefined ? {} : { limit }),
      });
      if (r.hits.length === 0) {
        yield { type: "text", text: `no matches in ${r.threads} thread${r.threads === 1 ? "" : "s"}${values.visible === true ? "" : " (what the model already sees is left out: --visible includes it)"}${r.notes.map((n) => `\n(${n})`).join("")}` };
        return;
      }
      const lines = r.hits.map((h) => `${h.ref}  #${h.n} ${h.kind}${h.relation === "self" ? "" : ` (${h.relation})`}\n    ${h.excerpt}`);
      yield { type: "text", text: `${r.total} match${r.total === 1 ? "" : "es"} in ${r.threads} thread${r.threads === 1 ? "" : "s"}${r.total > r.hits.length ? `, the closest ${r.hits.length} shown (--limit)` : ""}\n${lines.join("\n")}${r.notes.map((n) => `\n(${n})`).join("")}` };
    } catch (e) {
      if (e instanceof SearchError) yield { type: "error", message: e.message };
      else throw e;
    }
  },
};

export const searchCommands: Command[] = [searchCommand];
