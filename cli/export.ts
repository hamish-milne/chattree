import type { Conversation } from "../harness/conversation.ts";
import type { ChatEntry } from "../harness/entries.ts";
import { inlineBlobs } from "../harness/context-builder.ts";

const fence = (body: string): string => {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}\n${body}\n${f}`;
};

/**
 * A thread as Markdown, for sharing: what was said, in order, with attachments named and tool calls shown. It is a rendering
 * of the transcript (which stays the record); setup changes and the like are one-line notes.
 */
export async function exportMarkdown(convo: Conversation, entries: readonly ChatEntry[], opts: { thread: string; thinking: boolean; now: Date }): Promise<string> {
  const text = async (x: string | { sha256: string; bytes: number }): Promise<string> => {
    if (typeof x === "string") return x;
    const bytes = await convo.store.get(x.sha256);
    return bytes === undefined ? `(missing text, ${x.bytes} bytes)` : new TextDecoder().decode(bytes);
  };
  const out: string[] = [`# ${opts.thread}`, `*Exported ${opts.now.toISOString()}.*`];
  for (const e of entries) {
    switch (e.$tag) {
      case "user": {
        const parts: string[] = [];
        for (const p of e.content) parts.push(p.$tag === "text" ? await text(p.text) : `*Attached ${p.name ?? p.data.sha256.slice(0, 8)} (${p.data.mime ?? "unknown type"}, ${p.data.bytes} bytes).*`);
        out.push(`## You\n\n${parts.join("\n\n")}`);
        break;
      }
      case "assistant": {
        const parts: string[] = [];
        for (const b of e.blocks) {
          if (b.$tag === "text") parts.push(await text(b.text));
          else if (b.$tag === "reasoning" && opts.thinking && b.visible !== undefined && b.visible !== "") parts.push((await text(b.visible)).split("\n").map((l) => `> ${l}`).join("\n"));
          else if (b.$tag === "tool_call") parts.push(`*Tool call:* \`${b.name}\`\n\n${fence(JSON.stringify(await inlineBlobs(b.args, text), null, 2))}`);
        }
        out.push(`## ${e.model}\n\n${parts.join("\n\n")}`);
        break;
      }
      case "tool_result":
        out.push(`*Tool result${e.is_error ? " (error)" : ""}:*\n\n${fence(await text(e.content))}`);
        break;
      case "interrupted": {
        const parts: string[] = [];
        for (const b of e.partial) if (b.$tag === "text") parts.push(await text(b.text));
        out.push(`*The reply was interrupted${e.by === "user" ? " by the user" : e.error === undefined ? "" : `: ${e.error}`}.*${parts.length > 0 ? `\n\n${parts.join("\n\n")}` : ""}`);
        break;
      }
      case "compaction":
        out.push(`*Earlier messages were summarised:*\n\n${(await text(e.summary)).split("\n").map((l) => `> ${l}`).join("\n")}`);
        break;
      case "fork_merge":
        out.push(`*A side conversation (${e.branch}) was merged back:*\n\n${(await text(e.summary)).split("\n").map((l) => `> ${l}`).join("\n")}`);
        break;
      case "job_event":
        out.push(`*Background job ${e.job} ${e.status}:* ${await text(e.summary)}${e.output === undefined ? "" : `\n\n${fence(await text(e.output))}`}`);
        break;
      case "subagent_result":
        out.push(`*Subagent ${e.branch} finished:*\n\n${(await text(e.summary)).split("\n").map((l) => `> ${l}`).join("\n")}`);
        break;
      case "branch_start":
        out.push(`*This thread started as a ${e.kind} of ${e.from.branch}.*`);
        break;
      case "agent_setup":
        if (e.model !== undefined && e.reason !== "provider") out.push(`*Model set to ${e.model.provider}/${e.model.id}.*`);
        break;
      case "header":
      case "approval":
        break;
    }
  }
  return `${out.join("\n\n")}\n`;
}
