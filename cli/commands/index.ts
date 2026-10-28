import type { Command } from "../registry.ts";
import { chatCommands } from "./chat.ts";
import { draftCommands } from "./drafts.ts";
import { execCommands } from "./exec.ts";
import { metaCommands } from "./meta.ts";
import { miscCommands } from "./misc.ts";
import { readCommands } from "./read.ts";
import { sessionCommands } from "./sessions.ts";
import { setupCommands } from "./setup.ts";
import { threadCommands } from "./threads.ts";
import { toolCommands } from "./tools.ts";
import { undoCommands } from "./undo.ts";

export function defaultCommands(): Command[] {
  return [...chatCommands, ...draftCommands, ...readCommands, ...sessionCommands, ...threadCommands, ...setupCommands, ...miscCommands, ...undoCommands, ...metaCommands, ...toolCommands, ...execCommands];
}
