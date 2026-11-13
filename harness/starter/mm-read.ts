import { PathRefused, display, resolveInWorkspace } from "./workspace.ts";
import type { Tool } from "../tools.ts";
import { PATH_ALIASES, flattenArgs } from "./args.ts";
import { ALL } from "../approvals.ts";

/** The most bytes of a picture, sound or document `mm_read` hands to the model. A larger file is refused, never cut. */
export const MM_READ_MAX_BYTES = 5 * 1024 * 1024;

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, s: string): boolean => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));

/** What a file is, from its first bytes (never from its name). */
export function sniffMedia(b: Uint8Array): { mime: string; kind: "picture" | "sound" | "document" } | { unsupported: string } | undefined {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", kind: "picture" };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", kind: "picture" };
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return { mime: "image/gif", kind: "picture" };
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return { mime: "image/webp", kind: "picture" };
  if (ascii(b, 0, "%PDF-")) return { mime: "application/pdf", kind: "document" };
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) return { mime: "audio/wav", kind: "sound" };
  if (ascii(b, 0, "fLaC")) return { mime: "audio/flac", kind: "sound" };
  if (ascii(b, 0, "ID3") || (b[0] === 0xff && ((b[1] as number) & 0xe0) === 0xe0)) return { mime: "audio/mpeg", kind: "sound" };
  if (ascii(b, 0, "OggS")) return { unsupported: "an Ogg file; convert it to wav, mp3 or flac first" };
  if (ascii(b, 0, "BM")) return { unsupported: "a BMP picture; convert it to png first" };
  if (ascii(b, 4, "ftyp")) return { unsupported: "an MP4/M4A file; convert audio to wav, mp3 or flac first" };
  return undefined;
}

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
      const found = sniffMedia(bytes);
      if (found === undefined) return fail(`${name} is not a picture, sound or PDF that mm_read knows (png, jpeg, gif, webp, wav, mp3, flac, pdf); for text use read`);
      if ("unsupported" in found) return fail(`${name} is ${found.unsupported}`);
      return { content: `${name}: ${found.kind} (${found.mime}, ${bytes.length} bytes), shown below`, media: [{ name, mime: found.mime, bytes }] };
    },
  };
}
