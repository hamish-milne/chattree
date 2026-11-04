import type { Conversation } from "./conversation.ts";
import { openEntry, refThread, search, SearchError, type Hit, type Scope } from "./search.ts";
import type { Tool, ToolOutput } from "./tools.ts";

/**
 * The `search` tool (docs/tools.md, 4.4). Searching the asking thread's own history needs the key `current`; anything that reads another
 * thread (a wider scope, or opening an entry of another thread) needs `other`, which also covers `current`. `all` covers both.
 */
export interface SearchToolDeps {
  /** Any conversation of the project. */
  convo: Conversation;
}

const KEYS = ["current", "other"];

function wanted(args: Record<string, unknown>, thread: string | undefined): "current" | "other" {
  const entry = args["entry"] as string | undefined;
  if (entry !== undefined) return refThread(entry) === thread ? "current" : "other";
  return (args["scope"] as Scope | undefined) === undefined || args["scope"] === "thread" ? "current" : "other";
}

const line = (h: Hit): string => `${h.ref}  #${h.n} ${h.kind}${h.relation === "self" ? "" : ` (${h.relation === "other" ? "other thread" : h.relation})`}: ${h.excerpt}`;

export function searchTool(deps: SearchToolDeps): Tool {
  return {
    definition: {
      name: "search",
      description:
        "Search the conversation's history for words or a pattern, including tool results and tool-call arguments that were left out of what you see (trimmed or summarised away). By default it searches this thread only and leaves out what is already in front of you. Every word must occur; \"quote\" a phrase; regex:true treats the query as a regular expression. scope family also searches the threads you came from, the ones you started and your siblings; project searches every thread, and both need approval. Hits are references like thread:ENTRYID: give one as `entry` to read that entry in full.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "What to look for." },
          entry: { type: "string", description: "A reference from an earlier search (thread:ENTRYID) to read in full, instead of searching." },
          scope: { type: "string", enum: ["thread", "family", "project"], description: "Which threads. Default thread (this one)." },
          regex: { type: "boolean", description: "The query is a regular expression. Default false." },
          include_visible: { type: "boolean", description: "Also report what is already in your context. Default false." },
          reasoning: { type: "boolean", description: "Search the readable reasoning of earlier responses too. Default false." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "How many hits to return, the closest threads first. Default 10." },
        },
      },
    },
    allowKeys: (args, ctx) => [wanted(args, ctx.thread)],
    covers: (keys, args, ctx) => {
      const want = wanted(args, ctx.thread);
      const hit = keys.find((k) => k === want) ?? (want === "current" ? keys.find((k) => k === "other") : undefined);
      return hit === undefined ? undefined : [hit];
    },
    validateKey: (key) => (KEYS.includes(key) ? undefined : "the keys are current (this thread's own history) and other (any other thread)"),
    execute: async (args, ctx): Promise<ToolOutput> => {
      const thread = ctx.thread;
      if (thread === undefined) return { content: "this call has no thread to search from", is_error: true };
      try {
        if (typeof args["entry"] === "string") {
          const r = await openEntry(deps.convo, args["entry"]);
          return "error" in r ? { content: r.error, is_error: true } : { content: r.text };
        }
        const query = args["query"] as string | undefined;
        if (query === undefined || query.trim() === "") return { content: "give a query to search for, or an entry to read", is_error: true };
        const scope = (args["scope"] as Scope | undefined) ?? "thread";
        const r = await search(deps.convo, thread, {
          query,
          scope,
          regex: args["regex"] === true,
          includeVisible: args["include_visible"] === true,
          reasoning: args["reasoning"] === true,
          ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
        });
        if (r.hits.length === 0) return { content: `No matches in ${r.threads} thread${r.threads === 1 ? "" : "s"} (${scope}).${args["include_visible"] === true ? "" : " What is already in your context is not searched; include_visible:true searches it too."}${r.notes.map((n) => `\n(${n})`).join("")}` };
        return {
          content: `${r.total} match${r.total === 1 ? "" : "es"} in ${r.threads} thread${r.threads === 1 ? "" : "s"} (${scope})${r.total > r.hits.length ? `, the closest ${r.hits.length} shown` : ""}.\n${r.hits.map(line).join("\n")}\n(Read one in full with entry: "<reference>".)${r.notes.map((n) => `\n(${n})`).join("")}`,
        };
      } catch (e) {
        if (e instanceof SearchError) return { content: e.message, is_error: true };
        throw e;
      }
    },
  };
}
