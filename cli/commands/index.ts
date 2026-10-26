import type { Command } from "../registry.ts";
import { chatCommands } from "./chat.ts";
import { metaCommands } from "./meta.ts";
import { readCommands } from "./read.ts";

export function defaultCommands(): Command[] {
  return [...chatCommands, ...readCommands, ...metaCommands];
}
