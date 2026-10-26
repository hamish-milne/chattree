import type { Output } from "./output.ts";
import type { Ctx } from "./engine.ts";

/**
 * A slash command. `busy` says whether it may run while a request is in flight ("blocked" commands answer with the
 * reason). A command that stages something for the next prompt names, in `stages`, the commands that show and clear what
 * it staged; the registry refuses one whose partners do not exist (docs/cli.md, section 4).
 */
export interface Command {
  name: string;
  aliases?: string[];
  summary: string;
  usage: string;
  busy: "allowed" | "blocked";
  stages?: { show: string; clear: string };
  run(ctx: Ctx, args: string[], rest: string): AsyncGenerator<Output, void>;
}

export class Registry {
  readonly #byName = new Map<string, Command>();
  readonly commands: readonly Command[];

  constructor(commands: readonly Command[]) {
    this.commands = commands;
    for (const c of commands) {
      for (const n of [c.name, ...(c.aliases ?? [])]) {
        if (this.#byName.has(n)) throw new Error(`two commands are called /${n}`);
        this.#byName.set(n, c);
      }
    }
    for (const c of commands) {
      if (c.stages === undefined) continue;
      for (const partner of [c.stages.show, c.stages.clear]) {
        if (!this.#byName.has(partner)) throw new Error(`/${c.name} stages state for the next prompt, so /${partner} must exist to show or clear it`);
      }
    }
  }

  find(name: string): Command | undefined {
    return this.#byName.get(name);
  }

  /** Names for completion: commands and their aliases. */
  names(): string[] {
    return [...this.#byName.keys()].sort();
  }
}

/** Split a command line the way a shell would: whitespace separates, quotes and backslashes group and escape. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur !== "") out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (quote !== undefined) throw new Error(`unclosed ${quote} in the command`);
  if (has || cur !== "") out.push(cur);
  return out;
}

/** `/name rest` -> the name and what follows it, or undefined for text that is not a command (including `//text`). */
export function parseCommand(line: string): { name: string; rest: string } | undefined {
  if (!line.startsWith("/") || line.startsWith("//")) return undefined;
  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(line);
  return m === null ? undefined : { name: m[1] as string, rest: (m[2] as string).replace(/\s+$/, "") };
}
