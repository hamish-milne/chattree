import type { InjectionContext, InjectionRule } from "./injections.ts";

/**
 * What the model is told about where it is (docs/context.md, section 2): a fixed description of chattree in the system prompt, and the facts that
 * change (the system, the thread, the date) in an `environment` injection, so a new day or a fork costs one short message and not the cached prefix.
 */

/**
 * The system prompt. It is part of the cached prefix, so a change to the text is a change for every thread: the version at its end says which
 * wording a thread started with, and a new wording is a new version.
 */
export const SYSTEM_PROMPT = `You are an assistant working in chattree, a harness that keeps a conversation as a Git repository. Be concise, and say plainly when you are unsure.

- Thread: this conversation is a thread, a branch of the repository with its own working directory. The files you read and write are in that directory. Every message, tool call and result is saved in the thread's transcript, and the user can look back and undo.
- Git: the thread's working directory is a git repository that stores a log of this conversation and the changes to the files under it. Do NOT use git commands; your changes are saved automatically. The user already understands all this, so don't re-state it.
- Forks and subagents: a fork continues the conversation on its own branch with everything said so far; a subagent starts fresh on its own branch with only the brief it is given and reports back when done. File changes come back by merging, and where two threads changed the same file the receiving thread's version is kept.
- Tools: the tools you are offered are described in their definitions, and only those exist. A call may need the user's approval; if it is declined or cannot run, say so and carry on or ask. To save context, long tool output, long tool arguments and reasoning of older steps may be left out of what you see, and a summary may replace older messages; if you need something that was left out, run the command again, and do not repeat earlier output.
- Skills: when a skill list is given and a task matches one, call the skill tool and follow what it returns.
- Notes from the harness: a message starting "[Note from the harness]" comes from chattree and not from the user. It carries usage warnings, reminders and facts about the environment. Follow it when it applies.

(chattree system prompt, version 2)`;

/** What the host knows about the machine; the harness adds the thread and the workspace. */
export interface HostEnvironment {
  /** `Linux 6.18`, `Windows 11`, `macOS 15`. */
  os: string;
  platform: "windows" | "posix";
  /** Where the `run` and `script` commands come from. */
  utilities: string;
  timeZone: string;
}

export interface EnvironmentFacts extends HostEnvironment {
  /** The thread: its branch name. */
  thread: string;
  /** The thread's working directory. */
  workspace: string;
}

const day = (now: number, timeZone: string): string => {
  const d = new Date(now);
  const opts = { timeZone } as const;
  const date = new Intl.DateTimeFormat("en-CA", { ...opts, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return `${new Intl.DateTimeFormat("en-US", { ...opts, weekday: "long" }).format(d)} ${date}`;
};

/** The note the model is shown: stable text for the same facts and the same day. */
export function environmentText(f: EnvironmentFacts, now: number): string {
  return [
    `Environment: ${f.os} (${f.platform === "windows" ? "Windows paths use backslashes, but the tools take forward slashes too" : "POSIX"}). Time zone ${f.timeZone}; today is ${day(now, f.timeZone)}.`,
    `Thread: ${f.thread}. Workspace: ${f.workspace}; tool paths are relative to it.`,
    `Commands: ${f.utilities}`,
  ].join("\n");
}

export const ENVIRONMENT_KEY = "environment";

/**
 * Say where the model is on its first request in a thread, and again only when the text would differ from the last time (a new day, a fork,
 * a changed setting). It reads that last time from the history, so it keeps no state.
 */
export function environmentRule(facts: EnvironmentFacts): InjectionRule {
  return (ctx: InjectionContext) => {
    const text = environmentText(facts, ctx.now);
    const last = ctx.entries.findLast((e) => e.$tag === "injection" && e.key === ENVIRONMENT_KEY);
    if (last?.$tag === "injection" && last.text === text) return undefined;
    return { key: ENVIRONMENT_KEY, text };
  };
}
