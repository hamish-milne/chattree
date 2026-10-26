/**
 * The command syntax of the `run` tool (docs/tools.md, 4.1): a small, safe subset of shell that we parse ourselves, so
 * that nothing runs through a shell and what a user approves is the parsed programs and arguments.
 *
 * Supported: words with `'single'` and `"double"` quotes and backslash escapes; `|` pipes; `<` from, `>` to and `>>` append
 * to a workspace file (`/dev/null` discards); unquoted `*` `?` `[...]` `{a,b}` globs (expanded by the caller against the
 * workspace); `$NAME` and `${NAME}` (expanded by the caller's callback, which decides which names are allowed); and
 * `2>&1` (stderr is always shown with stdout, so it changes nothing). Everything else that a shell would do (`;`, `&&`,
 * `||`, `&`, backticks, `$(...)`, subshells, heredocs, `VAR=x cmd`, `~`, redirecting stderr to a file) is refused with
 * a message that points to the `script` tool, never guessed at.
 */

export interface Word {
  text: string;
  /** Contains an unquoted wildcard, so the caller expands it to the matching workspace files. */
  glob: boolean;
}

export interface ParsedCommand {
  /** Each stage is `[program, ...arguments]`. */
  stages: Word[][];
  /** A workspace file for the first stage's input. */
  stdin?: Word;
  /** Where the last stage's stdout goes instead of coming back as the result. */
  stdout?: { target: Word | "discard"; append: boolean };
}

export class CommandSyntax extends Error {
  override name = "CommandSyntax";
}

const SCRIPT = "use the script tool for that";
const refuse = (what: string): never => {
  throw new CommandSyntax(`${what} is not supported by run (${SCRIPT})`);
};

/** Characters a backslash escapes outside quotes; before any other character it is an ordinary backslash (Windows paths). */
const ESCAPABLE = new Set([" ", "\t", "'", '"', "\\", "$", "|", "<", ">", "&", ";", "*", "?", "[", "]", "{", "}", "(", ")", "`", "~"]);
const WILD = new Set(["*", "?", "["]);
const NAME_START = /[A-Za-z_]/;
const NAME = /[A-Za-z0-9_]/;
const BRACES = /\{[^{}]*,[^{}]*\}/;

type Token = { kind: "word"; word: Word; quoted: boolean } | { kind: "op"; op: "|" | "<" | ">" | ">>" };

export function parseCommand(input: string, expand: (name: string) => string): ParsedCommand {
  const src = input.replace(/\s+$/, "");
  if (src.trim() === "") throw new CommandSyntax("the command is empty");
  const tokens: Token[] = [];
  let text = "";
  let inWord = false;
  let quoted = false;
  let wild = false;
  let i = 0;

  const flush = (): void => {
    if (!inWord) return;
    tokens.push({ kind: "word", word: { text, glob: wild || (!quoted && BRACES.test(text)) }, quoted });
    text = "";
    inWord = false;
    quoted = false;
    wild = false;
  };
  const op = (o: "|" | "<" | ">" | ">>"): void => {
    flush();
    tokens.push({ kind: "op", op: o });
  };
  /** `$NAME` or `${NAME}` at `i` (which is at the `$`); returns true when it consumed a variable. */
  const variable = (): boolean => {
    const next = src[i + 1];
    if (next === "(") return refuse("`$(...)`");
    if (next === "{") {
      const close = src.indexOf("}", i + 2);
      const name = close === -1 ? "" : src.slice(i + 2, close);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return refuse("`${...}` other than a plain ${NAME}");
      text += expand(name);
      i = close + 1;
      return true;
    }
    if (next !== undefined && NAME_START.test(next)) {
      let j = i + 2;
      while (j < src.length && NAME.test(src[j] as string)) j++;
      text += expand(src.slice(i + 1, j));
      i = j;
      return true;
    }
    return false;
  };

  while (i < src.length) {
    const c = src[i] as string;
    if (c === " " || c === "\t") {
      flush();
      i++;
    } else if (c === "\n" || c === "\r") {
      throw new CommandSyntax(`a command is a single line (${SCRIPT} for several commands)`);
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      if (close === -1) throw new CommandSyntax("a ' quote is never closed");
      text += src.slice(i + 1, close);
      inWord = quoted = true;
      i = close + 1;
    } else if (c === '"') {
      inWord = quoted = true;
      i++;
      for (;;) {
        if (i >= src.length) throw new CommandSyntax('a " quote is never closed');
        const d = src[i] as string;
        if (d === '"') {
          i++;
          break;
        }
        if (d === "`") refuse("backticks");
        if (d === "\\" && i + 1 < src.length && ['"', "\\", "$", "`"].includes(src[i + 1] as string)) {
          text += src[i + 1];
          i += 2;
        } else if (d === "$") {
          if (!variable()) {
            text += "$";
            i++;
          }
        } else {
          text += d;
          i++;
        }
      }
    } else if (c === "\\") {
      const d = src[i + 1];
      inWord = true;
      if (d !== undefined && ESCAPABLE.has(d)) {
        text += d;
        quoted = true;
        i += 2;
      } else {
        text += "\\";
        i++;
      }
    } else if (c === "$") {
      inWord = true;
      if (!variable()) {
        text += "$";
        i++;
      }
    } else if (c === "`") {
      refuse("backticks");
    } else if (c === "|") {
      if (src[i + 1] === "|") refuse("`||`");
      op("|");
      i++;
    } else if (c === ";") {
      refuse("`;`");
    } else if (c === "(" || c === ")") {
      refuse("subshells and `(...)`");
    } else if (c === "&") {
      if (src[i + 1] === "&") refuse("`&&`");
      if (src[i + 1] === ">") refuse("`&>`");
      refuse("`&` (background jobs)");
    } else if (c === "<") {
      if (src[i + 1] === "<") refuse("heredocs and here-strings");
      if (src[i + 1] === "(") refuse("process substitution");
      op("<");
      i++;
    } else if (c === ">" || ((c === "1" || c === "2") && !inWord && src[i + 1] === ">")) {
      let fd = 1;
      if (c !== ">") {
        fd = Number(c);
        i++;
      }
      // here src[i] is the `>`
      let append = false;
      i++;
      if (src[i] === ">") {
        append = true;
        i++;
      }
      if (src[i] === "&") {
        const m = /^&([12])/.exec(src.slice(i));
        if (m === null) return refuse("this redirection");
        i += 2; // `2>&1`, `>&2`: stderr is shown with stdout already, so this changes nothing
        continue;
      }
      if (fd === 2) {
        // `2>/dev/null` is accepted and changes nothing; any other file for stderr is refused.
        flush();
        while (src[i] === " " || src[i] === "\t") i++;
        if (src.startsWith("/dev/null", i) && (i + 9 === src.length || /[\s|]/.test(src[i + 9] as string))) {
          i += 9;
          continue;
        }
        refuse("redirecting stderr to a file (stderr is shown with the output; `2>/dev/null` and `2>&1` are accepted)");
      }
      op(append ? ">>" : ">");
    } else if (c === "~" && !inWord) {
      refuse("`~` (use a path relative to the workspace)");
    } else {
      inWord = true;
      if (WILD.has(c)) wild = true;
      text += c;
      i++;
    }
  }
  flush();

  // Tokens to stages and redirects.
  const stages: Word[][] = [[]];
  let stdin: Word | undefined;
  let stdout: ParsedCommand["stdout"];
  let stdinStage = -1;
  let stdoutStage = -1;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k] as Token;
    if (t.kind === "word") {
      (stages[stages.length - 1] as Word[]).push(t.word);
    } else if (t.op === "|") {
      if ((stages[stages.length - 1] as Word[]).length === 0) throw new CommandSyntax("a `|` needs a command before it");
      stages.push([]);
    } else {
      const target = tokens[k + 1];
      if (target === undefined || target.kind !== "word") throw new CommandSyntax(`\`${t.op}\` needs a file name after it`);
      k++;
      if (t.op === "<") {
        if (stdin !== undefined) throw new CommandSyntax("only one `<` is supported");
        stdin = target.word;
        stdinStage = stages.length - 1;
      } else {
        if (stdout !== undefined) throw new CommandSyntax("only one `>` or `>>` is supported");
        stdout = { target: target.word.text === "/dev/null" ? "discard" : target.word, append: t.op === ">>" };
        stdoutStage = stages.length - 1;
      }
    }
  }
  if ((stages[stages.length - 1] as Word[]).length === 0) throw new CommandSyntax(stages.length === 1 ? "the command is empty" : "a `|` needs a command after it");
  if (stdinStage > 0) throw new CommandSyntax("`<` only works on the first command of a pipeline");
  if (stdoutStage !== -1 && stdoutStage !== stages.length - 1) throw new CommandSyntax("`>` only works on the last command of a pipeline");
  if (stdin?.text === "/dev/null") stdin = undefined;

  const first = tokens.find((t) => t.kind === "word") as Extract<Token, { kind: "word" }> | undefined;
  if (first !== undefined && !first.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.word.text) && stages[0]?.[0] === first.word) {
    throw new CommandSyntax(`setting a variable before a command (${first.word.text.split("=")[0]}=...) is not supported by run (${SCRIPT})`);
  }
  for (const stage of stages) if ((stage[0] as Word).glob) throw new CommandSyntax("the program name cannot be a wildcard");
  return { stages, ...(stdin === undefined ? {} : { stdin }), ...(stdout === undefined ? {} : { stdout }) };
}
