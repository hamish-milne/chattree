/** How tool calls and results look in a session (docs/tools.md, section 6): one start line, one result line, a short preview. */

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** One line for a call: `read src/a.ts`, `run pnpm test`, `script: set -e`, `edit src/a.ts`. */
export function summarizeCall(name: string, args: Record<string, unknown>): string {
  const command = str(args["command"]);
  if (name === "run" && command !== undefined) return `run${args["background"] === true ? " (background)" : ""} ${clip(command, 100)}`;
  const script = str(args["script"]);
  if (name === "script" && script !== undefined) return `script${args["background"] === true ? " (background)" : ""}: ${clip(script.split("\n")[0] ?? "", 90)}`;
  const path = str(args["path"]);
  if (path !== undefined) return `${name} ${path}`;
  const job = str(args["job"]);
  if (job !== undefined) return `${name} ${job}`;
  const rest = Object.keys(args).length === 0 ? "" : ` ${clip(JSON.stringify(args), 80)}`;
  return `${name}${rest}`;
}

/** What the user is shown before deciding: exactly what will run, in full for a script. */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const script = str(args["script"]);
  if (name === "script" && script !== undefined) return `script${args["background"] === true ? " (in the background)" : ""}:\n${script.split("\n").map((l) => `  ${l}`).join("\n")}`;
  const command = str(args["command"]);
  if (name === "run" && command !== undefined) return `run${args["background"] === true ? " (in the background)" : ""}: ${command}`;
  const json = JSON.stringify(args, null, 2);
  return `${name} ${json.length > 1500 ? `${json.slice(0, 1500)}…` : json}`;
}

/** The result line, and up to three lines of the output beneath it. */
export function resultLines(o: { is_error: boolean; content: string; ms: number; truncated: boolean }): { head: string; preview: string[]; more: boolean } {
  const bytes = new TextEncoder().encode(o.content).length;
  const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
  const lines = o.content.split("\n");
  const preview = lines.slice(0, 3).map((l) => clip(l, 120)).filter((l) => l !== "");
  return { head: `${o.is_error ? "failed" : "ok"} · ${size} · ${o.ms} ms${o.truncated ? " · cut for the model" : ""}`, preview, more: lines.length > 3 || o.truncated };
}
