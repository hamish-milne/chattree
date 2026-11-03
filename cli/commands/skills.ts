import type { Conversation } from "../../harness/conversation.ts";
import { loadPinned } from "../../harness/definitions.ts";
import { hasSkillTool, asSkill, driftSize, skillDrift, skillText, syncSkills, type SkillValue } from "../../harness/skills.ts";
import type { AgentSetup } from "../../harness/setup.ts";
import { stable } from "../../harness/setup.ts";
import { describeDrift, scanProjectSkills, skillPolicy } from "../skills.ts";
import type { Command } from "../registry.ts";
import type { Output } from "../output.ts";
import { failure } from "../turn.ts";
import { sendMessage } from "./chat.ts";

const loadSkill = async (convo: Conversation, name: string, pin: AgentSetup["skills"][string]): Promise<SkillValue | undefined> => asSkill(await loadPinned("skill", name, pin, { blobs: convo.store }).catch(() => undefined));
const flat = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

const skills: Command = {
  name: "skills",
  summary: "list the skills (and which the model's cached prefix lists), or take changes from disk",
  usage: "/skills [sync]",
  busy: "blocked",
  async complete(_ctx, previous, partial) {
    return previous.length === 0 ? ["sync"].filter((s) => s.startsWith(partial)) : [];
  },
  async *run(ctx, args): AsyncGenerator<Output, void> {
    try {
      const scan = await scanProjectSkills(ctx.io, ctx.engine.project);
      const setup = await ctx.convo.setup();
      const drift = await skillDrift(setup.skills, scan);
      if (args[0] === "sync") {
        if (args.length > 1) {
          yield { type: "error", message: `unknown option ${args[1]}`, hint: "/skills [sync]" };
          return;
        }
        for (const p of scan.problems) yield { type: "warning", message: p };
        if (driftSize(drift) === 0) {
          yield { type: "notice", message: "the skills are already what is on disk" };
          return;
        }
        const done = await syncSkills(ctx.convo, scan);
        if (done === undefined) {
          yield { type: "notice", message: "the skills are already what is on disk" };
          return;
        }
        yield { type: "notice", message: `skills updated: ${describeDrift(done)}; the model is told of the change with its next request` };
        return;
      }
      if (args.length > 0) {
        yield { type: "error", message: `unknown option ${args[0]}`, hint: "/skills [sync]" };
        return;
      }
      const names = [...new Set([...Object.keys(setup.skills), ...Object.keys(setup.prefix.skills)])].sort();
      const rows: string[] = [];
      for (const name of names) {
        const pin = setup.skills[name];
        const shown = setup.prefix.skills[name];
        const state = pin === undefined ? "removed, still in the catalog until /rebuild" : shown === undefined ? "announced only (not in the catalog until /rebuild)" : stable(shown) === stable(pin) ? "in the catalog" : "in the catalog (older text; the model was told of the change)";
        const value = pin === undefined ? undefined : await loadSkill(ctx.convo, name, pin);
        rows.push(`${name}  [${state}]${value === undefined ? "" : `  ${flat(value.description, 100)}`}`);
      }
      yield { type: "text", text: rows.length === 0 ? "no skills are pinned to this thread" : rows.join("\n") };
      if (names.length > 0 && !hasSkillTool(setup)) yield { type: "warning", message: "the skill tool is not enabled (add `skill:` under tools in harness.yml), so the model is not shown the catalog" };
      if (driftSize(drift) > 0) yield { type: "notice", message: `on disk: ${describeDrift(drift)}; /skills sync takes them (skills.follow is ${await skillPolicy(ctx.convo)})` };
      for (const p of scan.problems) yield { type: "warning", message: p };
    } catch (e) {
      yield failure(e);
    }
  },
};

const skill: Command = {
  name: "skill",
  summary: "send a skill's instructions to the model as your message, with what you want done",
  usage: "/skill <name> [what to do]",
  busy: "blocked",
  async complete(ctx, previous, partial) {
    return previous.length === 0 ? Object.keys((await ctx.convo.setup()).skills).filter((n) => n.startsWith(partial)).sort() : [];
  },
  async *run(ctx, args, rest): AsyncGenerator<Output, void> {
    try {
      const name = args[0];
      if (name === undefined) {
        yield { type: "error", message: "which skill?", hint: "/skill <name> [what to do]; /skills lists them" };
        return;
      }
      const setup = await ctx.convo.setup();
      const pin = setup.skills[name];
      if (pin === undefined) {
        const onDisk = (await scanProjectSkills(ctx.io, ctx.engine.project)).skills[name] !== undefined;
        yield { type: "error", message: `there is no skill ${name} pinned to this thread`, hint: onDisk ? "it is on disk: /skills sync pins it" : `pinned: ${Object.keys(setup.skills).sort().join(", ") || "none"}` };
        return;
      }
      const value = await loadSkill(ctx.convo, name, pin);
      if (value === undefined) {
        yield { type: "error", message: `the skill ${name} is pinned but its text could not be read` };
        return;
      }
      const request = rest.replace(/^\s*\S+\s*/, "").trim();
      const text = `[The user invoked the skill ${name}; follow it]\n${skillText(value)}${request === "" ? "" : `\n\nThe user's request: ${request}`}`;
      yield* sendMessage(ctx, text, () => undefined);
    } catch (e) {
      yield failure(e);
    }
  },
};

export const skillCommands: Command[] = [skills, skill];
