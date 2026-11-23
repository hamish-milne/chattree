/**
 * Quick start: a conversation for a code repository that has none, kept in the conversations folder of the user's data directory
 * and not in the repository (ADR 40). The code is linked in as an attached repository (ADR 38), so the repository stays exactly as
 * it was: no branch, no commits, no files of ours in it.
 *
 * What ties the two together is written by the host in the code's own workspace (the extension keeps it in `.vscode/settings.json`,
 * a map from the repository's path, relative to the workspace folder, to the conversation's path), so a repository that is moved or
 * renamed takes its link with it, and the link in the conversation is made again at the new place (`WorkspaceLink`).
 */
import { createHash } from "node:crypto";
import { dataDir } from "../localmodels/plan.ts";
import { AppError } from "./errors.ts";
import { runInit, type InitEnv } from "./init.ts";
import { findProject, openThread, safeDirName } from "./project.ts";
import { CONFIG_FILE } from "../harness/conversation.ts";

/** What the conversation calls a linked repository: for the workspace folder itself `code`, for another path its name with `-` for `/`. */
export function linkNameFor(key: string): string {
  const clean = key.replace(/^\.[\\/]+/, "");
  if (clean === "." || clean === "") return "code";
  const name = clean
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "");
  return name === "" ? "code" : name;
}

/** The folder that holds the conversations of quick-started repositories. */
export function conversationsHome(io: InitEnv): string {
  const data = dataDir(io.host, io.env, io.settings?.data_dir);
  if (data === undefined)
    throw new AppError("there is no data directory on this machine to keep the conversation in", "set data_dir in the settings file");
  return io.host.path.join(data, "conversations");
}

export interface QuickStarted {
  /** The conversation's folder. */
  project: string;
  /** The name the code has in it. */
  name: string;
}

/**
 * Make a conversation (no provider yet) for the repository at `code`, link the code into it as `linkNameFor(key)`, and say where it is.
 * A conversation already there for this repository is reused, so a lost setting can be made again.
 */
export async function quickStart(io: InitEnv, o: { code: string; key: string }): Promise<QuickStarted> {
  const { host } = io;
  const real = (await host.fs.realpath(o.code)) ?? o.code;
  const dir = host.path.join(
    conversationsHome(io),
    `${safeDirName(
      host.path
        .resolve(real)
        .split(/[\\/]/)
        .findLast((p) => p !== "") ?? "code",
    )}-${createHash("sha1").update(real).digest("hex").slice(0, 8)}`,
  );
  if ((await host.fs.stat(host.path.join(dir, CONFIG_FILE))) === undefined) await runInit(io, { dir, provider: "none" });
  const name = linkNameFor(o.key);
  const project = await findProject(io, dir);
  const { convo } = await openThread(io, project, undefined, { providers: "optional" });
  try {
    await convo.linkExternal(name, o.code);
  } finally {
    await convo.close();
  }
  return { project: project.root, name };
}
