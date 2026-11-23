/**
 * The built-in slash commands, in the order /help lists them. Each group lives in its own file; a new command goes in the group it
 * belongs to, and the group is added to the list returned here.
 */
import type { Command } from "../registry.ts";
import { searchCommands } from "./search.ts";
import { settingsCommands } from "./settings.ts";
import { chatCommands } from "./chat.ts";
import { draftCommands } from "./drafts.ts";
import { execCommands } from "./exec.ts";
import { metaCommands } from "./meta.ts";
import { miscCommands } from "./misc.ts";
import { pushCommands } from "./push.ts";
import { readCommands } from "./read.ts";
import { sessionCommands } from "./sessions.ts";
import { setupCommands } from "./setup.ts";
import { mcpCommands } from "./mcp.ts";
import { skillCommands } from "./skills.ts";
import { threadCommands } from "./threads.ts";
import { toolCommands } from "./tools.ts";
import { trustCommands } from "./trust.ts";
import { undoCommands } from "./undo.ts";

export function defaultCommands(): Command[] {
  return [
    ...chatCommands,
    ...draftCommands,
    ...readCommands,
    ...sessionCommands,
    ...threadCommands,
    ...setupCommands,
    ...skillCommands,
    ...mcpCommands,
    ...miscCommands,
    ...undoCommands,
    ...pushCommands,
    ...metaCommands,
    ...toolCommands,
    ...execCommands,
    ...trustCommands,
    ...settingsCommands,
    ...searchCommands,
  ];
}
