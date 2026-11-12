import type { ToolDefinition } from "../../harness/definitions.ts";
import type { Dialect, Parser, RenderInput } from "../dialect.ts";
import { anyOf, defineFamily, jsonCall, tagParams, type FamilySpec } from "./family.ts";
import { argNode } from "./schema-tree.ts";
import { spacedJson } from "./scan.ts";

/**
 * The format of Qwen3.5 (and the Qwen3-Coder family): tools as JSON lines in the system turn with a plain-English instruction, calls as
 * `<tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>`, results as `<tool_response>` in a user turn, and
 * thinking in `<think>`. Rendering reproduces the model's own template (parity tests); it departs from it in:
 *   Q1  a tool result is not trimmed (its trailing newline is meaningful, and the harness formats results itself);
 *   Q2  a boolean argument is written `true`/`false` and null as `null`, not as the template's Python `True`/`None`.
 * Options: `thinking` (default true): the prompt ends inside `<think>`, so the model thinks first; false asks for no thinking;
 * `keep_reasoning` (default true): the reasoning of the unfinished exchange is replayed, as the template does (earlier exchanges never are);
 * `instructions`: the text after the tool list that restates the call format (a string, or `false` for none; default the template's).
 */

const INSTRUCTIONS = `

If you choose to call a function ONLY reply in the following format with NO suffix:

<tool_call>
<function=example_function_name>
<parameter=example_parameter_1>
value_1
</parameter>
<parameter=example_parameter_2>
This is the value for the second parameter
that can span
multiple lines
</parameter>
</function>
</tool_call>

<IMPORTANT>
Reminder:
- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags
- Required parameters MUST be specified
- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after
- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls
</IMPORTANT>`;

const SPEC: FamilySpec = {
  id: "qwen-xml",
  head: ({ system, tools, options }) => {
    const given = options["instructions"];
    const instructions = given === false ? "" : typeof given === "string" ? `\n\n${given}` : INSTRUCTIONS;
    if (tools.length > 0) return `<|im_start|>system\n# Tools\n\nYou have access to the following functions:\n\n<tools>${tools.map((t) => `\n${spacedJson({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })}`).join("")}\n</tools>${instructions}${system === "" ? "" : `\n\n${system}`}<|im_end|>\n`;
    return system === "" ? "" : `<|im_start|>system\n${system}<|im_end|>\n`;
  },
  user: { open: "<|im_start|>user\n", close: "<|im_end|>\n" },
  assistant: { open: "<|im_start|>assistant\n", close: "<|im_end|>\n" },
  results: { open: "<|im_start|>user", close: "<|im_end|>\n", item: "\n<tool_response>\n{content}\n</tool_response>" },
  call: {
    start: "<tool_call>",
    end: "</tool_call>",
    gap: "\n\n",
    gapEmpty: "",
    between: "\n",
    codec: anyOf(tagParams({ head: "\n<function={name}>\n", param: "<parameter={key}>\n{value}\n</parameter>\n", tail: "</function>\n" }), jsonCall()),
  },
  think: { open: "<think>\n", close: "\n</think>\n\n", start: "<think>\n", skip: "<think>\n\n</think>\n\n", emptyBlock: true },
};

export const qwenXml: Dialect = defineFamily(SPEC);
export const renderQwen = (input: RenderInput): { prompt: string; stop: string[] } => qwenXml.render(input);
export const qwenParser = (options: Record<string, unknown>, tools: Parameters<typeof argNode>[0], prompt: string): Parser => qwenXml.parser(options, tools as readonly ToolDefinition[], prompt);
