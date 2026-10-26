import type { Command } from "../registry.ts";
import { chatCommands } from "./chat.ts";
import { metaCommands } from "./meta.ts";
import { readCommands } from "./read.ts";
import { sessionCommands } from "./sessions.ts";
import { setupCommands } from "./setup.ts";
import { threadCommands } from "./threads.ts";

export function defaultCommands(): Command[] {
  return [...chatCommands, ...readCommands, ...sessionCommands, ...threadCommands, ...setupCommands, ...metaCommands];
}
