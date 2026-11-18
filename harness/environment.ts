import type { InjectionContext, InjectionRule } from "./injections.ts";

/**
 * What the model is told about where it is: a fixed description of chattree in the system prompt, and the facts that
 * change (the system, the thread, the date) in an `environment` injection, so a new day or a fork costs one short
 * message and not the cached prefix.
 */

/**
 * The system prompt. It is part of the cached prefix, so a change to the text is a change for every thread: the
 * version at its end says which wording a thread started with, and a new wording is a new version.
 */
export const SYSTEM_PROMPT = `You are an assistant working in chattree, a harness that keeps a conversation as a Git repository. Be concise, and say plainly when you are unsure.

- Thread: this conversation is a thread, a branch of the repository with its own working directory. The files you read and write are in that directory. Every message, tool call and result is saved in the thread's transcript, and the user can look back and undo.
- Git: the thread's working directory is a git repository that stores a log of this conversation and the changes to the files under it. Do NOT use git commands; your changes are saved automatically. The user already understands all this, so don't re-state it.
- Attachments: pictures and sound the user attaches are given to you directly. If one seems blank, silent or not there, it may be empty or damaged, so say that; never conclude that you cannot see or hear.
- Forks and subagents: a fork continues the conversation on its own branch with everything said so far; a subagent starts fresh on its own branch with only the brief it is given and reports back when done. File changes come back by merging, and where two threads changed the same file the receiving thread's version is kept.
- Tools: the tools you are offered are described in their definitions, and only those exist. A call may need the user's approval; if it is declined or cannot run, say so and carry on or ask. To save context, long tool output, long tool arguments and reasoning of older steps may be left out of what you see, and a summary may replace older messages; if you need something that was left out, run the command again, and do not repeat earlier output.
- Files: when you tell the user about a file, write it as a Markdown link whose target is the path relative to the workspace, with a line or a range when it helps, and never a bare file name. The user's screen turns it into a link that opens the file. Example: [retry loop](src/net/retry.ts#L42-L58), or [package.json](package.json) for a whole file. Use the path as the tools take it; do not make up lines you have not seen.
- Skills: when a skill list is given and a task matches one, call the skill tool and follow what it returns.
- Notes from the harness: a message starting "[Note from the harness]" comes from chattree and not from the user. It carries usage warnings, reminders and facts about the environment. Follow it when it applies.

(chattree system prompt, version 4)`;

/** What the host knows about the machine; the harness adds the thread and the workspace. */
export interface HostEnvironment {
  /** `Linux 6.18`, `Windows 11`, `macOS 15`. */
  os: string;
  platform: "windows" | "posix";
  /** Where the `run` and `script` commands come from. */
  utilities: string;
  timeZone: string;
}

/** What the `environment` note says; each defaults to true (`injections.environment_details` in harness.yml). */
export const ENVIRONMENT_PARTS = ["os", "time_zone", "date", "thread", "workspace", "commands"] as const;
export type EnvironmentPart = (typeof ENVIRONMENT_PARTS)[number];

export interface EnvironmentFacts extends HostEnvironment {
  /** The thread: its branch name. */
  thread: string;
  /** The thread's working directory. A change in it is a change in the note, so the model is told again when the workspace moves. */
  workspace: string;
  /** Parts to leave out: those set to false. */
  show?: Partial<Record<EnvironmentPart, boolean>>;
}

const day = (now: number, timeZone: string): string => {
  const d = new Date(now);
  const opts = { timeZone } as const;
  const date = new Intl.DateTimeFormat("en-CA", { ...opts, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return `${new Intl.DateTimeFormat("en-US", { ...opts, weekday: "long" }).format(d)} ${date}`;
};

/** The note the model is shown: stable text for the same facts and the same day. Empty when every part is left out. */
export function environmentText(f: EnvironmentFacts, now: number): string {
  const on = (p: EnvironmentPart): boolean => f.show?.[p] !== false;
  const platformNote = f.platform === "windows" ? "Windows paths use backslashes, but the tools take forward slashes too" : "POSIX";
  const first: string[] = [];
  if (on("os")) first.push(`Environment: ${f.os} (${platformNote}).`);
  if (on("time_zone") && on("date")) first.push(`Time zone ${f.timeZone}; today is ${day(now, f.timeZone)}.`);
  else if (on("time_zone")) first.push(`Time zone ${f.timeZone}.`);
  else if (on("date")) first.push(`Today is ${day(now, f.timeZone)}.`);
  const second: string[] = [];
  if (on("thread")) second.push(`Thread: ${f.thread}.`);
  if (on("workspace")) second.push(`Workspace: ${f.workspace}; tool paths are relative to it.`);
  return [first.join(" "), second.join(" "), on("commands") ? `Commands: ${f.utilities}` : ""].filter((l) => l !== "").join("\n");
}

export const ENVIRONMENT_KEY = "environment";

/**
 * Say where the model is on its first request in a thread, and again only when the text would differ from the last time (a new day, a fork,
 * a changed setting). It reads that last time from the history, so it keeps no state.
 */
export function environmentRule(facts: EnvironmentFacts): InjectionRule {
  return (ctx: InjectionContext) => {
    const text = environmentText(facts, ctx.now);
    if (text === "") return undefined;
    const last = ctx.entries.findLast((e) => e.$tag === "injection" && e.key === ENVIRONMENT_KEY);
    if (last?.$tag === "injection" && last.text === text) return undefined;
    return { key: ENVIRONMENT_KEY, text };
  };
}
