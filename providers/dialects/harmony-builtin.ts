/**
 * Built-in tools for Harmony (docs/local-models.md, 9.5). gpt-oss was trained on `python` and `browser` as built-ins: described in prose in
 * the system block, called on the `analysis` channel with the recipient set to the tool's name and the code as the bare message. A tool
 * that a model's settings list under `dialect_options.builtin_tools` is presented that way instead of in `namespace functions`, with the
 * convention stated in the developer block and shown by an example, because the model calls them in a mix of ways otherwise (probes in
 * docs/local-models.md: bare or JSON about half and half, on either channel, with an invented `cmd` array for a shell).
 *
 * The tool itself is an ordinary chattree tool; only its presentation and the reading of its calls change. A call is read leniently when
 * that is unambiguous (any channel, a `functions.` prefix, a bare message, or JSON with one key holding a string or a list of strings,
 * which is joined with spaces) and anything else is not run, and the model is told how to call the tool.
 */

export interface BuiltinSpec {
  /** The tool's argument that the bare message is. */
  arg: string;
  /** The tool's section of the system block. */
  prose: string;
  /** What the message is, in the words of the instructions (`Python code`). */
  what: string;
  /** A short message that is correct. */
  example: string;
}

const PYTHON = `## python

Use this tool to execute Python code in your chain of thought. The code will not be shown to the user. This tool should be used for internal reasoning, but not for code that is intended to be visible to the user (e.g. when creating plots, tables, or files).

When you send a message containing Python code to python, it will be executed in a stateful Jupyter notebook environment. python will respond with the output of the execution or time out after 120.0 seconds. Internet access for this session is disabled.`;

const BASH = `## bash

Use this tool to run shell commands. When you send a message containing a shell command to bash, it will be executed in the workspace directory, and bash will respond with the command's output or time out after 60.0 seconds.`;

/** The tools Harmony models know best, with the argument that a chattree tool of that name takes. */
const KNOWN: Record<string, BuiltinSpec> = {
  python: { arg: "code", prose: PYTHON, what: "Python code", example: "print(6 * 7)" },
  bash: { arg: "command", prose: BASH, what: "shell command", example: "ls -l" },
};

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `{python: true, bash: {arg: "cmd"}}` from the options: a name alone takes what is known of it, and a name that is not known needs its `arg`. */
export function builtinSpecs(option: unknown): Map<string, BuiltinSpec> {
  const out = new Map<string, BuiltinSpec>();
  if (!isMap(option)) return out;
  for (const [name, v] of Object.entries(option)) {
    if (v === false) continue;
    const given = isMap(v) ? v : {};
    const known = KNOWN[name];
    const arg = typeof given["arg"] === "string" ? given["arg"] : (known?.arg ?? "command");
    const text = (k: string, fallback: string): string => (typeof given[k] === "string" ? (given[k] as string) : fallback);
    out.set(name, { arg, prose: text("prose", known?.prose ?? `## ${name}\n\nUse this tool by sending its input as the message.`), what: text("what", known?.what ?? "input"), example: text("example", known?.example ?? "") });
  }
  return out;
}

/** The developer block's rules for the built-ins that are offered, with an example of each, and what happens to the other tools. */
export function builtinPreamble(offered: readonly (readonly [string, BuiltinSpec])[], hasFunctions: boolean): string {
  const names = offered.map(([n]) => n);
  const rest = hasFunctions ? " Every other tool is a function: call it on the commentary channel with to=functions.NAME and JSON-encoded arguments." : "";
  return `IMPORTANT. You MUST follow these rules exactly for the built-in tools ${names.join(" and ")}. They are not functions.
1. You MUST call a built-in tool on the analysis channel, with the recipient set to the tool's name (${names.map((n) => `to=${n}`).join(", ")}). You MUST NOT use the commentary channel or the functions. prefix for them.
2. The message MUST be only the ${offered.map(([, s]) => s.what).join(" or ")} itself, as bare text. You MUST NOT wrap it in JSON, you MUST NOT use argument names such as "code", "cmd" or "command", and you MUST NOT use quotes or arrays.
${offered.map(([n, s]) => `Example call to ${n}:\n  channel: analysis\n  recipient: ${n}\n  message: ${s.example}`).join("\n")}
A call that cannot be understood is NOT run and is answered with an error.${rest}`;
}

/** What the model wrote as the message of a call to a built-in, as the tool's argument; or why it cannot be read without guessing. */
export function messageOf(name: string, spec: BuiltinSpec, body: string): { text: string } | { error: string } {
  const text = body.trim();
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { text }; // not JSON: bare, as it should be
  }
  if (isMap(value)) {
    const values = Object.values(value);
    const only = values.length === 1 ? values[0] : undefined;
    if (typeof only === "string") return { text: only };
    if (Array.isArray(only) && only.length > 0 && only.every((x) => typeof x === "string")) return { text: (only as string[]).join(" ") };
    return {
      error: `${name} was NOT run: its message was JSON that cannot be read as one ${spec.what}. ${name} is a built-in tool: call it on the analysis channel with the recipient ${name}, and make the message only the ${spec.what}, as bare text, with no JSON and no argument names. Example: channel analysis, recipient ${name}, message: ${spec.example}. Call it again exactly like this.`,
    };
  }
  return { text }; // a number, a string or a list on its own: bare text that happens to parse
}
