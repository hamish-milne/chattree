import { loadPinned } from "./definitions.ts";
import { asSkill, skillText } from "./skills.ts";
import type { Tool, ToolOutput } from "./tools.ts";

/** How many names an error lists. */
const LISTED = 200;

/**
 * The `skill` tool (docs/context.md, section 2): takes a skill's name and returns its instructions as the result, so the model reads a
 * skill when a task calls for it instead of carrying every skill in the prefix. It serves the skills the setup pins now, not the ones
 * the cached catalog lists: a skill added since is served, one removed is refused (an error that lists what is available).
 */
export function skillTool(): Tool {
  return {
    definition: {
      name: "skill",
      description:
        "Read the instructions of one of the skills listed in your skill list. Call it with the skill's name when the task matches that skill, then follow what it returns. If the skill has a directory, files it mentions are there and can be read with `read`.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string", description: "The skill's name, as listed." } },
      },
    },
    allowKeys: () => ["all"],
    execute: async (args, ctx): Promise<ToolOutput> => {
      const name = String(args["name"] ?? "").trim();
      if (ctx.setup === undefined || ctx.blobs === undefined) return { content: "skills are not available here", is_error: true };
      const skills = (await ctx.setup()).skills;
      const pin = skills[name];
      if (pin === undefined) {
        const names = Object.keys(skills).sort();
        return { content: `there is no skill called ${JSON.stringify(name)}${names.length === 0 ? "; no skills are available" : `; the skills are: ${names.slice(0, LISTED).join(", ")}${names.length > LISTED ? `, and ${names.length - LISTED} more` : ""}`}`, is_error: true };
      }
      try {
        const value = asSkill(await loadPinned("skill", name, pin, { blobs: ctx.blobs }));
        if (value === undefined) return { content: `the skill ${name} is pinned but its text is damaged`, is_error: true };
        return { content: skillText(value) };
      } catch (e) {
        return { content: `the skill ${name} could not be read: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
      }
    },
  };
}
