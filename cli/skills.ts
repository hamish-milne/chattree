import type { Conversation } from "../harness/conversation.ts";
import { driftSize, scanSkills, skillDrift, skillRoots, syncSkills, userSkillsDir, type SkillDrift, type SkillScan } from "../harness/skills.ts";
import type { Io } from "./io.ts";
import type { Project } from "./project.ts";

/** Read the skills on disk for this project: the user's directory and the project root's `.agents/skills` and `.chattree/skills`. */
export const scanProjectSkills = (io: Io, project: Project): Promise<SkillScan> => scanSkills(io.host, skillRoots(io.host, project.mainRoot, userSkillsDir(io.host, io.env)));

/** `skills.follow` from harness.yml (default `ask`). */
export async function skillPolicy(convo: Conversation): Promise<"auto" | "ask" | "off"> {
  const cfg = await convo.readConfig();
  return cfg?.ok === true ? cfg.value.skills.follow : "ask";
}

/** "1 added (a), 2 changed (b, c)" */
export function describeDrift(d: SkillDrift): string {
  const part = (n: string, names: string[]): string[] => (names.length === 0 ? [] : [`${names.length} ${n} (${names.join(", ")})`]);
  return [...part("added", d.added), ...part("changed", d.changed), ...part("removed", d.removed)].join(", ");
}

/**
 * Look at the disk for a thread, as `skills.follow` says. `auto` pins what changed (the model is told where it was made); `ask` only reports
 * it, and `/skills sync` takes it. Returns one sentence for the user, or undefined when nothing differs or the policy is `off`.
 */
export async function followSkills(io: Io, project: Project, convo: Conversation): Promise<{ drift: SkillDrift; note: string } | undefined> {
  const policy = await skillPolicy(convo);
  if (policy === "off") return undefined;
  const setup = await convo.setup();
  if (setup.model === undefined) return undefined;
  const scan = await scanProjectSkills(io, project);
  if (policy === "auto") {
    const done = await syncSkills(convo, scan);
    return done === undefined ? undefined : { drift: done, note: `skills followed the disk: ${describeDrift(done)}; the model is told where the change was made` };
  }
  const drift = await skillDrift(setup.skills, scan);
  return driftSize(drift) === 0 ? undefined : { drift, note: `skills changed on disk: ${describeDrift(drift)}; /skills sync takes them` };
}

/** For the status line: how many skills differ from the disk when the policy is `ask` (with `auto` the next request takes them; with `off` nobody looks). */
export async function skillsWaiting(io: Io, project: Project, convo: Conversation): Promise<number> {
  if ((await skillPolicy(convo)) !== "ask") return 0;
  const setup = await convo.setup();
  if (setup.model === undefined) return 0;
  return driftSize(await skillDrift(setup.skills, await scanProjectSkills(io, project)));
}
