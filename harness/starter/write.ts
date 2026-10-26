import { PathRefused, display, resolveInWorkspace } from "./workspace.ts";
import type { Tool } from "../tools.ts";

const enc = new TextEncoder();

export function writeTool(): Tool {
  return {
    definition: {
      name: "write",
      description:
        "Create files or replace them whole, creating directories as needed. Takes a list of files, written in order; it stops at the first failure and says what was written. To change part of an existing file, use edit instead.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["files"],
        properties: {
          files: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            description: "The files to write.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "content"],
              properties: {
                path: { type: "string", description: "Path relative to the workspace root." },
                content: { type: "string", description: "The complete new content of the file." },
              },
            },
          },
        },
      },
    },
    async execute(args, ctx) {
      const { host, workspace } = ctx;
      const files = args["files"] as { path: string; content: string }[];
      const lines: string[] = [];
      for (const [i, f] of files.entries()) {
        try {
          const abs = await resolveInWorkspace(host, workspace, f.path, "write");
          const name = display(host, workspace, abs);
          const before = await host.fs.stat(abs);
          if (before?.isDirectory === true) throw new PathRefused(`${name} is a directory`);
          const bytes = enc.encode(f.content);
          await host.fs.writeAtomic(abs, bytes, { keepMode: true });
          lines.push(before === undefined ? `created ${name} (${bytes.length} bytes)` : `replaced ${name} (${bytes.length} bytes, was ${before.size})`);
        } catch (e) {
          const rest = files.length - i - 1;
          lines.push(`failed: ${f.path}: ${e instanceof Error ? e.message : String(e)}${rest > 0 ? `; the other ${rest} file${rest === 1 ? " was" : "s were"} not written` : ""}`);
          return { content: lines.join("\n"), is_error: true };
        }
      }
      return { content: lines.join("\n") };
    },
  };
}
