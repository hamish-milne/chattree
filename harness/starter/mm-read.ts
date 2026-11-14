import { PathRefused, display, resolveInWorkspace } from "./workspace.ts";
import type { Tool } from "../tools.ts";
import { PATH_ALIASES, flattenArgs } from "./args.ts";
import { ALL } from "../approvals.ts";
import { convertHint, sniffFormat } from "../formats.ts";

/** The most bytes of a picture, sound or document `mm_read` hands to the model. A larger file is refused, never cut. */
export const MM_READ_MAX_BYTES = 5 * 1024 * 1024;

export function mmReadTool(): Tool {
  return {
    normalize: (args) => flattenArgs(args, { path: PATH_ALIASES }),
    definition: {
      name: "mm_read",
      description: `Look at a picture, listen to a sound or read a PDF in the workspace: the file itself is shown to you with the result. Pictures: png, jpeg, gif, webp. Sound: wav, mp3, flac. A PDF only if the model takes them. Files over ${MM_READ_MAX_BYTES / (1024 * 1024)} MiB are refused. For text files use read.`,
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string", description: "Path of the file, relative to the workspace root." } },
      },
    },
    allowKeys: () => [ALL],
    async execute(args, ctx) {
      const { host, workspace } = ctx;
      const path = String(args["path"]);
      const fail = (m: string) => ({ content: m, is_error: true });
      let abs: string;
      try {
        abs = await resolveInWorkspace(host, workspace, path, "read");
      } catch (e) {
        if (e instanceof PathRefused) return fail(e.message);
        throw e;
      }
      const name = display(host, workspace, abs);
      const st = await host.fs.stat(abs);
      if (st === undefined) return fail(`${name}: no such file`);
      if (st.isDirectory) return fail(`${name} is a directory`);
      if (st.size === 0) return fail(`${name} is empty (0 bytes), so there is nothing to show`);
      if (st.size > MM_READ_MAX_BYTES) return fail(`${name} is ${st.size} bytes, over the ${MM_READ_MAX_BYTES} byte limit for mm_read; make a smaller copy (a lower resolution or a shorter clip)`);
      const bytes = await host.fs.read(abs);
      const found = await sniffFormat(bytes);
      if (found === undefined) return fail(`${name} is not a picture, sound or PDF that mm_read knows (png, jpeg, gif, webp, wav, mp3, flac, pdf); for text use read`);
      if (found.kind === "video") return fail(`${name} is ${found.label}; video is not supported yet`);
      if (!found.direct) return fail(`${name} is ${found.label}; convert it to ${convertHint(found)} first`);
      return { content: `${name}: ${found.kind === "image" ? "picture" : found.kind === "audio" ? "sound" : "document"} (${found.mime}, ${bytes.length} bytes), shown below`, media: [{ name, mime: found.mime, bytes }] };
    },
  };
}
