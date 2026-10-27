import { PathRefused, display, resolveInWorkspace } from "./workspace.ts";
import type { Tool, ToolContext } from "../tools.ts";
import { versionOf } from "./version.ts";
import { PATH_ALIASES, flattenArgs } from "./args.ts";
import { ALL } from "../approvals.ts";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_LINES = 2000;
const MAX_ENTRIES = 500;
const dec = new TextDecoder("utf-8", { fatal: true });

const lineNumbered = (lines: string[], first: number): string => {
  const width = String(first + lines.length - 1).length;
  return lines.map((l, i) => `${String(first + i).padStart(width)}\t${l}`).join("\n");
};

interface Item {
  path: string;
  offset?: number;
  limit?: number;
}

async function readOne(ctx: ToolContext, item: Item): Promise<{ text: string; ok: boolean }> {
  const { host, workspace } = ctx;
  const failed = (path: string, why: string) => ({ text: `=== ${path}: ${why} ===`, ok: false });
  let bytes: Uint8Array;
  let name = item.path;
  if (item.path.startsWith("blob:")) {
    const hash = item.path.slice(5);
    if (!/^[0-9a-f]{64}$/.test(hash)) return failed(item.path, "a blob address is blob: followed by 64 hex digits");
    const found = await ctx.blobs?.get(hash);
    if (found === undefined) return failed(item.path, "no such blob");
    bytes = found;
  } else {
    let abs: string;
    try {
      abs = await resolveInWorkspace(host, workspace, item.path, "read");
    } catch (e) {
      if (e instanceof PathRefused) return failed(item.path, e.message);
      throw e;
    }
    name = display(host, workspace, abs);
    const st = await host.fs.stat(abs);
    if (st === undefined) return failed(name, "no such file");
    if (st.isDirectory) {
      const names = (await host.fs.readdir(abs)).sort();
      const shown = names.slice(0, MAX_ENTRIES);
      const lines: string[] = [];
      for (const n of shown) lines.push(`${n}${(await host.fs.stat(host.path.join(abs, n)))?.isDirectory === true ? "/" : ""}`);
      return { text: `=== ${name}/ (${names.length} entries) ===\n${lines.join("\n")}${names.length > shown.length ? `\n... ${names.length - shown.length} more entries` : ""}`, ok: true };
    }
    if (st.size > MAX_FILE_BYTES) return failed(name, `${st.size} bytes is too large to read whole; use run with head, tail or grep`);
    bytes = await host.fs.read(abs);
  }
  if (bytes.subarray(0, 8000).includes(0)) return failed(name, "a binary file");
  let text: string;
  try {
    text = dec.decode(bytes);
  } catch {
    return failed(name, "not UTF-8 text");
  }
  const v = item.path.startsWith("blob:") ? "" : `, version ${await versionOf(bytes)}`;
  if (text === "") return { text: `=== ${name} (empty file${v}) ===`, ok: true };
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  const offset = item.offset ?? 0;
  const limit = item.limit ?? DEFAULT_LINES;
  if (offset >= all.length) return failed(name, `only ${all.length} lines; offset ${offset} is past the end`);
  const slice = all.slice(offset, offset + limit);
  const partial = offset > 0 || offset + limit < all.length;
  const head = (partial ? `lines ${offset + 1}-${offset + slice.length} of ${all.length}` : `${all.length} line${all.length === 1 ? "" : "s"}`) + v;
  const more = offset + slice.length < all.length ? `\n... ${all.length - offset - slice.length} more lines; read again with offset ${offset + slice.length} for the rest` : "";
  return { text: `=== ${name} (${head}) ===\n${lineNumbered(slice, offset + 1)}${more}`, ok: true };
}

export function readTool(): Tool {
  return {
    normalize: (args) => flattenArgs(args, { path: PATH_ALIASES, offset: ["start", "skip"], limit: ["lines", "max_lines", "count"] }),
    definition: {
      name: "read",
      description:
        "Read one text file from the workspace. The result gives the file's version (`version` and 8 hex digits) and its lines, each with its line number; edit needs both. A file longer than `limit` lines (default 2000) is cut, and the result says which `offset` to use for the rest. A directory returns a listing. A path of the form blob:<sha256> reads stored output that an earlier result named. To read several files, make one read call for each, all in the same turn.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", description: "Path of the file, relative to the workspace root." },
          offset: { type: "integer", minimum: 0, description: "Number of lines to skip from the start. Default 0." },
          limit: { type: "integer", minimum: 1, description: "Most lines to return. Default 2000." },
        },
      },
    },
    allowKeys: () => [ALL],
    async execute(args, ctx) {
      const r = await readOne(ctx, args as unknown as Item);
      return { content: r.text, is_error: !r.ok };
    },
  };
}
