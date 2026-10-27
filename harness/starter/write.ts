import { PathRefused, display, resolveInWorkspace } from "./workspace.ts";
import type { Tool } from "../tools.ts";
import { versionOf } from "./version.ts";
import { PATH_ALIASES, flattenArgs } from "./args.ts";
import { ALL } from "../approvals.ts";

const enc = new TextEncoder();

export function writeTool(): Tool {
  return {
    normalize: (args) => flattenArgs(args, { path: PATH_ALIASES, content: ["contents", "text", "data", "body"] }),
    definition: {
      name: "write",
      description:
        "Create one file, or replace an existing one whole, creating directories as needed. Give the complete new content. If the file you replace ended with a newline, the new content does too. To change only part of an existing file, use edit instead. To write several files, make one write call for each.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string", description: "Path of the file, relative to the workspace root." },
          content: { type: "string", description: "The complete new content of the file." },
        },
      },
    },
    allowKeys: () => [ALL],
    async execute(args, ctx) {
      const { host, workspace } = ctx;
      const f = args as { path: string; content: string };
      try {
        const abs = await resolveInWorkspace(host, workspace, f.path, "write");
        const name = display(host, workspace, abs);
        const before = await host.fs.stat(abs);
        if (before?.isDirectory === true) throw new PathRefused(`${name} is a directory`);
        let content = f.content;
        let note = "";
        // A whole-file write often loses the last newline of a file that had one; keep it.
        if (before !== undefined && content !== "" && !content.endsWith("\n") && before.size > 0) {
          const old = await host.fs.read(abs);
          if (old.at(-1) === 0x0a) {
            const crlf = old.at(-2) === 0x0d;
            content += crlf ? "\r\n" : "\n";
            note = "; added the final newline the file had";
          }
        }
        const bytes = enc.encode(content);
        await host.fs.writeAtomic(abs, bytes, { keepMode: true });
        return { content: before === undefined ? `created ${name} (${bytes.length} bytes, version ${await versionOf(bytes)})` : `replaced ${name} (${bytes.length} bytes, was ${before.size}, version ${await versionOf(bytes)}${note})` };
      } catch (e) {
        if (!(e instanceof Error)) throw e;
        return { content: `failed: ${f.path}: ${e.message}`, is_error: true };
      }
    },
  };
}
