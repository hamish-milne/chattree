import type { ToolDefinition } from "../../harness/definitions.ts";
import type { Dialect } from "../dialect.ts";
import { defineFamily, jsonCall, nameThenJson, tagParams, type FamilySpec } from "./family.ts";
import { spacedJson } from "./scan.ts";

/**
 * Chat formats declared with `defineFamily` (family.ts): the tokens of each model's own template, checked against it by the parity
 * tests (test/providers/families.test.ts). All of them keep the choices the existing dialects make: reasoning is replayed only
 * for the unfinished exchange, a tool result is not trimmed, arguments are written as JSON with a space after `,` and `:`, and the
 * BOS token is left to the server where its tokenizer adds one (DeepSeek, Mistral) and written where the template spells it (GLM,
 * MiniMax). Each says here what it takes from its template and what it does not:
 *   hermes    Qwen3 and the many models with its `<tool_call>{json}</tool_call>` format (Hermes, Qwen2.5);
 *   mistral   Devstral and Mistral Small (v7 tokenizer: `[TOOL_CALLS]name[ARGS]{json}`), without call ids: results follow in order;
 *   kimi      Kimi K2: calls carry ids `functions.NAME:N`, which we number as Moonshot's API does; results are headed by them;
 *   deepseek  DeepSeek V3.1, non-thinking (the only mode its calls are defined for): its template does not render the tools, so the
 *             list is written as the model card says; the model carries on after tool outputs with no turn marker of its own;
 *   glm47     GLM-4.7 (and Flash): the same tags with no newlines, and the prompt ends inside `<think>`;
 *   glm       GLM-4.5 and 4.6: a tag for each argument, `<think></think>` stands for reasoning that is not replayed;
 *   minimax   MiniMax-M2: `<invoke>` calls in a `<minimax:tool_call>` section; always thinks.
 */

const tool = (t: ToolDefinition): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } } => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } });
const ENDS = "<|im_end|>\n";

// ---- Hermes / Qwen3 ---------------------------------------------------------------------------------------------------

const hermes: FamilySpec = {
  id: "hermes",
  head: ({ system, tools }) =>
    tools.length === 0
      ? system === "" ? "" : `<|im_start|>system\n${system}${ENDS}`
      : `<|im_start|>system\n${system === "" ? "" : `${system}\n\n`}# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>${tools.map((t) => `\n${spacedJson(tool(t))}`).join("")}\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>${ENDS}`,
  user: { open: "<|im_start|>user\n", close: ENDS },
  assistant: { open: "<|im_start|>assistant\n", close: ENDS },
  results: { open: "<|im_start|>user", close: ENDS, item: "\n<tool_response>\n{content}\n</tool_response>" },
  call: { start: "<tool_call>", end: "</tool_call>", gap: "\n", gapEmpty: "", between: "\n", codec: jsonCall({ lead: "\n", trail: "\n" }) },
  // Qwen3 thinks unless told not to, and writes `<think>` itself; models with no such tags never write them and nothing here changes.
  think: { open: "<think>\n", close: "\n</think>\n\n", skip: "<think>\n\n</think>\n\n" },
};

// ---- Mistral / Devstral ----------------------------------------------------------------------------------------------

const mistral: FamilySpec = {
  id: "mistral",
  head: ({ system, tools }) => `${system === "" ? "" : `[SYSTEM_PROMPT]${system}[/SYSTEM_PROMPT]`}${tools.length === 0 ? "" : `[AVAILABLE_TOOLS]${spacedJson(tools.map(tool))}[/AVAILABLE_TOOLS]`}`,
  user: { open: "[INST]", close: "[/INST]" },
  assistant: { open: "", close: "</s>" },
  results: { item: "[TOOL_RESULTS]{content}[/TOOL_RESULTS]" },
  call: { start: "[TOOL_CALLS]", codec: nameThenJson({ sep: "[ARGS]" }) },
};

// ---- Kimi K2 -----------------------------------------------------------------------------------------------------------

const KIMI_IDENTITY = "You are Kimi, an AI assistant created by Moonshot AI.";

const kimi: FamilySpec = {
  id: "kimi",
  head: ({ system, tools }) => `${tools.length === 0 ? "" : `<|im_system|>tool_declare<|im_middle|>${JSON.stringify(tools.map(tool))}<|im_end|>`}<|im_system|>system<|im_middle|>${system === "" ? KIMI_IDENTITY : system}<|im_end|>`,
  user: { open: "<|im_user|>user<|im_middle|>", close: "<|im_end|>" },
  assistant: { open: "<|im_assistant|>assistant<|im_middle|>", close: "<|im_end|>" },
  results: { item: "<|im_system|>{name}<|im_middle|>## Return of {id}\n{content}<|im_end|>" },
  call: {
    start: "<|tool_call_begin|>",
    end: "<|tool_call_end|>",
    section: { open: "<|tool_calls_section_begin|>", close: "<|tool_calls_section_end|>" },
    id: (name, n) => `functions.${name}:${n}`,
    codec: nameThenJson({ sep: "<|tool_call_argument_begin|>", name: (c) => c.id, nameOf: (s) => s.trim().replace(/^functions\./, "").replace(/:\d+$/, "") }),
  },
};

// ---- DeepSeek V3.1 -----------------------------------------------------------------------------------------------------

const DS = (s: string): string => s.replace(/\|/g, "｜").replace(/_/g, "▁");
const dsTools = (tools: readonly ToolDefinition[]): string =>
  `## Tools\nYou have access to the following tools:\n\n${tools.map((t) => `### ${t.name}\nDescription: ${t.description}\n\nParameters: ${spacedJson(t.input_schema)}`).join("\n\n")}\n\nIMPORTANT: ALWAYS adhere to this exact format for tool use:\n${DS("<|tool_calls_begin|><|tool_call_begin|>")}tool_call_name${DS("<|tool_sep|>")}tool_call_arguments${DS("<|tool_call_end|>")}{additional_tool_calls}${DS("<|tool_calls_end|>")}\n\nWhere:\n- \`tool_call_name\` must be an exact match to one of the available tools\n- \`tool_call_arguments\` must be valid JSON that strictly follows the tool's Parameters Schema\n- For multiple tool calls, chain them directly without separators or spaces`;

const deepseek: FamilySpec = {
  id: "deepseek",
  head: ({ system, tools }) => [system, tools.length === 0 ? "" : dsTools(tools)].filter((x) => x !== "").join("\n\n"),
  user: { open: DS("<|User|>"), close: "" },
  assistant: { open: DS("<|Assistant|>"), close: DS("<|end_of_sentence|>") },
  results: { item: `${DS("<|tool_output_begin|>")}{content}${DS("<|tool_output_end|>")}`, continues: true },
  call: {
    start: DS("<|tool_call_begin|>"),
    end: DS("<|tool_call_end|>"),
    section: { open: DS("<|tool_calls_begin|>"), close: DS("<|tool_calls_end|>") },
    codec: nameThenJson({ sep: DS("<|tool_sep|>") }),
  },
  // Calls are defined for the non-thinking mode only, so that is the default; the template drops reasoning from every exchange.
  think: { open: "<think>", close: "</think>", start: "<think>", skip: "</think>", absent: "</think>", never: true, default: false },
};

// ---- GLM-4.5 / 4.6 -----------------------------------------------------------------------------------------------------

const glm: FamilySpec = {
  id: "glm",
  head: ({ system, tools }) =>
    `[gMASK]<sop>${tools.length === 0 ? "" : `<|system|>\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>\n${tools.map((t) => `${spacedJson(tool(t))}\n`).join("")}</tools>\n\nFor each function call, output the function name and arguments within the following XML format:\n<tool_call>{function-name}\n<arg_key>{arg-key-1}</arg_key>\n<arg_value>{arg-value-1}</arg_value>\n<arg_key>{arg-key-2}</arg_key>\n<arg_value>{arg-value-2}</arg_value>\n...\n</tool_call>`}${system === "" ? "" : `<|system|>\n${system}`}`,
  user: { open: "<|user|>\n", close: "" },
  assistant: { open: "<|assistant|>", close: "", lead: "\n" },
  results: { open: "<|observation|>", item: "\n<tool_response>\n{content}\n</tool_response>" },
  call: { start: "<tool_call>", end: "</tool_call>", gap: "\n", gapEmpty: "\n", between: "\n", codec: tagParams({ head: "{name}\n", param: "<arg_key>{key}</arg_key>\n<arg_value>{value}</arg_value>\n" }) },
  think: { open: "\n<think>", close: "</think>", skip: "\n<think></think>", absent: "\n<think></think>" },
};

// ---- GLM-4.7 ------------------------------------------------------------------------------------------------------------

/** GLM-4.7's template drops every newline of 4.5/4.6's: `<|user|>text`, `<tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>`, `<tool_response>…</tool_response>`. */
const glm47: FamilySpec = {
  id: "glm47",
  head: ({ system, tools }) =>
    `[gMASK]<sop>${tools.length === 0 ? "" : `<|system|>\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>\n${tools.map((t) => `${spacedJson(tool(t))}\n`).join("")}</tools>\n\nFor each function call, output the function name and arguments within the following XML format:\n<tool_call>{function-name}<arg_key>{arg-key-1}</arg_key><arg_value>{arg-value-1}</arg_value><arg_key>{arg-key-2}</arg_key><arg_value>{arg-value-2}</arg_value>...</tool_call>`}${system === "" ? "" : `<|system|>${system}`}`,
  user: { open: "<|user|>", close: "" },
  assistant: { open: "<|assistant|>", close: "" },
  results: { open: "<|observation|>", item: "<tool_response>{content}</tool_response>" },
  call: { start: "<tool_call>", end: "</tool_call>", codec: tagParams({ head: "{name}", param: "<arg_key>{key}</arg_key><arg_value>{value}</arg_value>" }) },
  think: { open: "<think>", close: "</think>", start: "<think>", skip: "</think>", absent: "</think>" },
};

// ---- MiniMax-M2 ----------------------------------------------------------------------------------------------------------

const MINIMAX_IDENTITY = "You are MiniMax-M2, a helpful AI assistant built by MiniMax. Knowledge cutoff: 2025-06.";

const minimax: FamilySpec = {
  id: "minimax",
  head: ({ system, tools }) =>
    `]~!b[]~b]system\n${system === "" ? MINIMAX_IDENTITY : system}${tools.length === 0 ? "" : `\n\n# Tools\nYou may call one or more tools to assist with the user query.\nHere are the tools available in JSONSchema format:\n\n<tools>\n${tools.map((t) => `<tool>${spacedJson(tool(t).function)}</tool>\n`).join("")}</tools>\n\nWhen making tool calls, use XML format to invoke tools and pass parameters:\n\n<minimax:tool_call>\n<invoke name="tool-name-1">\n<parameter name="param-key-1">param-value-1</parameter>\n<parameter name="param-key-2">param-value-2</parameter>\n...\n</invoke>\n</minimax:tool_call>`}[e~[\n`,
  user: { open: "]~b]user\n", close: "[e~[\n" },
  assistant: { open: "]~b]ai\n", close: "[e~[\n" },
  results: { open: "]~b]tool", close: "[e~[\n", item: "\n<response>{content}</response>" },
  call: {
    start: '<invoke name="',
    end: "</invoke>",
    section: { open: "\n<minimax:tool_call>\n", close: "\n</minimax:tool_call>" },
    between: "\n",
    codec: tagParams({ head: '{name}">\n', param: '<parameter name="{key}">{value}</parameter>\n' }),
  },
  think: { open: "<think>\n", close: "\n</think>\n\n", start: "<think>\n" },
};

export const hermesDialect: Dialect = defineFamily(hermes);
export const mistralDialect: Dialect = defineFamily(mistral);
export const kimiDialect: Dialect = defineFamily(kimi);
export const deepseekDialect: Dialect = defineFamily(deepseek);
export const glmDialect: Dialect = defineFamily(glm);
export const glm47Dialect: Dialect = defineFamily(glm47);
export const minimaxDialect: Dialect = defineFamily(minimax);

export const familyDialects = (): Dialect[] => [hermesDialect, mistralDialect, kimiDialect, deepseekDialect, glmDialect, glm47Dialect, minimaxDialect];
