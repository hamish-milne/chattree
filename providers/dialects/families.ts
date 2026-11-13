import type { ToolDefinition } from "../../harness/definitions.ts";
import type { Dialect } from "../dialect.ts";
import { defineFamily, fencedJson, jsonCall, nameThenJson, tagParams, type FamilySpec } from "./family.ts";
import { spacedJson } from "./scan.ts";

/**
 * Chat formats declared with `defineFamily` (family.ts): the tokens of each model's own template, checked against it by the parity
 * tests (test/providers/families.test.ts). All of them keep the choices the existing dialects make: reasoning is replayed only
 * for the unfinished exchange, a tool result is not trimmed, arguments are written as JSON with a space after `,` and `:`, and the
 * BOS token is left to the server where its tokenizer adds one (Mistral) and written where the template spells it (GLM). Each says here what it takes from its template and what it does not:
 *   hermes    Qwen3 and the many models with its `<tool_call>{json}</tool_call>` format (Hermes, Qwen2.5);
 *   mistral   Devstral and Mistral Small (v7 tokenizer: `[TOOL_CALLS]name[ARGS]{json}`), without call ids: results follow in order;
 *   glm       GLM-4.7 and later (Flash too): a tag for each argument with no newlines, and the prompt ends inside `<think>`;
 *   glm46     GLM-4.5 and 4.6: the same tags with newlines between them, `<think></think>` stands for reasoning that is not replayed;
 *   kimi-vl   Kimi-VL, Thinking and Instruct (one template for both): no tool calls, thinking between `◁think▷` and `◁/think▷`;
 *   deepseek-r1  the R1 distills (and R1): DeepSeek's original call format, which the models' template can only replay: it never writes the tool list.
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

// ---- GLM-4.5 / 4.6 (glm46) -----------------------------------------------------------------------------------------------------

const glm46: FamilySpec = {
  id: "glm46",
  head: ({ system, tools }) =>
    `[gMASK]<sop>${tools.length === 0 ? "" : `<|system|>\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>\n${tools.map((t) => `${spacedJson(tool(t))}\n`).join("")}</tools>\n\nFor each function call, output the function name and arguments within the following XML format:\n<tool_call>{function-name}\n<arg_key>{arg-key-1}</arg_key>\n<arg_value>{arg-value-1}</arg_value>\n<arg_key>{arg-key-2}</arg_key>\n<arg_value>{arg-value-2}</arg_value>\n...\n</tool_call>`}${system === "" ? "" : `<|system|>\n${system}`}`,
  user: { open: "<|user|>\n", close: "" },
  assistant: { open: "<|assistant|>", close: "", lead: "\n" },
  results: { open: "<|observation|>", item: "\n<tool_response>\n{content}\n</tool_response>" },
  call: { start: "<tool_call>", end: "</tool_call>", gap: "\n", gapEmpty: "\n", between: "\n", codec: tagParams({ head: "{name}\n", param: "<arg_key>{key}</arg_key>\n<arg_value>{value}</arg_value>\n" }) },
  think: { open: "\n<think>", close: "</think>", skip: "\n<think></think>", absent: "\n<think></think>" },
};

// ---- GLM-4.7 ------------------------------------------------------------------------------------------------------------

/** GLM-4.7 and later: the template drops every newline of 4.5/4.6's (`glm46`): `<|user|>text`, `<tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>`, `<tool_response>…</tool_response>`. */
const glm: FamilySpec = {
  id: "glm",
  head: ({ system, tools }) =>
    `[gMASK]<sop>${tools.length === 0 ? "" : `<|system|>\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>\n${tools.map((t) => `${spacedJson(tool(t))}\n`).join("")}</tools>\n\nFor each function call, output the function name and arguments within the following XML format:\n<tool_call>{function-name}<arg_key>{arg-key-1}</arg_key><arg_value>{arg-value-1}</arg_value><arg_key>{arg-key-2}</arg_key><arg_value>{arg-value-2}</arg_value>...</tool_call>`}${system === "" ? "" : `<|system|>${system}`}`,
  user: { open: "<|user|>", close: "" },
  assistant: { open: "<|assistant|>", close: "" },
  results: { open: "<|observation|>", item: "<tool_response>{content}</tool_response>" },
  call: { start: "<tool_call>", end: "</tool_call>", codec: tagParams({ head: "{name}", param: "<arg_key>{key}</arg_key><arg_value>{value}</arg_value>" }) },
  think: { open: "<think>", close: "</think>", start: "<think>", skip: "</think>", absent: "</think>" },
};

// ---- Kimi-VL ---------------------------------------------------------------------------------------------------------------

/**
 * Kimi-VL-A3B (Thinking and Instruct have the very same template, so one dialect): `<|im_user|>user<|im_middle|>…<|im_end|>`, a default
 * system turn when there is none, no tools. Only the Thinking model writes `◁think▷ … ◁/think▷` (llama-server's own reasoning parser looks
 * for `<think>`, so through the chat endpoint that text arrives as the answer); the Instruct one never does, and the tags are then never met.
 * The picture is a marker; the server writes the `<|media_start|>image<|media_content|>…<|media_end|>` tokens around it.
 */
const kimiVl: FamilySpec = {
  id: "kimi-vl",
  head: ({ system }) => `<|im_system|>system<|im_middle|>${system === "" ? "You are a helpful assistant" : system}<|im_end|>`,
  user: { open: "<|im_user|>user<|im_middle|>", close: "<|im_end|>" },
  assistant: { open: "<|im_assistant|>assistant<|im_middle|>", close: "<|im_end|>" },
  results: { open: "<|im_user|>user<|im_middle|>", close: "<|im_end|>", item: "{content}" },
  think: { open: "◁think▷", close: "◁/think▷", never: true },
};

// ---- DeepSeek R1 ---------------------------------------------------------------------------------------------------------

/**
 * The R1 distills (Qwen and Llama weights) and R1 itself: the system text straight after the BOS (left to the server), `<｜User｜>`, `<｜Assistant｜>`,
 * the model's answer after `</think>` (with the blank line that follows it) is all that is kept in history, and the prompt ends in `<think>\n`. Their template has calls and results
 * in DeepSeek's original format but never reads the `tools` it is given, and the distills were not trained for calls, so the tool list is
 * written into the system text here (the same words as Hermes) and asked for in the format the template replays. Where this and the template
 * differ on calls: the template leaves `<｜tool▁calls▁end｜><｜end▁of▁sentence｜>` out after a single call (a bug of its own), this writes them as V3 does.
 * Experimental: nothing says these models call well.
 */
const deepseekR1: FamilySpec = {
  id: "deepseek-r1",
  head: ({ system, tools }) =>
    `${system}${tools.length === 0 ? "" : `${system === "" ? "" : "\n\n"}# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>${tools.map((t) => `\n${spacedJson(tool(t))}`).join("")}\n</tools>\n\nFor function calls, write them in this format (several calls go on separate lines inside one block):\n<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜><function-name>\n\`\`\`json\n<args-json-object>\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`}`,
  user: { open: "<｜User｜>", close: "" },
  assistant: { open: "<｜Assistant｜>", close: "<｜end▁of▁sentence｜>", lead: "\n\n" },
  results: { open: "<｜tool▁outputs▁begin｜>", close: "<｜tool▁outputs▁end｜>", between: "\n", item: "<｜tool▁output▁begin｜>{content}<｜tool▁output▁end｜>", continues: true },
  call: { start: "<｜tool▁call▁begin｜>", end: "<｜tool▁call▁end｜>", section: { open: "<｜tool▁calls▁begin｜>", close: "<｜tool▁calls▁end｜>" }, between: "\n", codec: fencedJson({ type: "function", sep: "<｜tool▁sep｜>" }) },
  think: { open: "<think>\n", close: "\n</think>\n\n", start: "<think>\n", skip: "<think>\n\n</think>\n\n", never: true },
};

export const hermesDialect: Dialect = defineFamily(hermes);
export const mistralDialect: Dialect = defineFamily(mistral);
export const glm46Dialect: Dialect = defineFamily(glm46);
export const glmDialect: Dialect = defineFamily(glm);
export const kimiVlDialect: Dialect = defineFamily(kimiVl);
export const deepseekR1Dialect: Dialect = defineFamily(deepseekR1);

export const familyDialects = (): Dialect[] => [hermesDialect, mistralDialect, glm46Dialect, glmDialect, kimiVlDialect, deepseekR1Dialect];

// Declarations for Kimi K2, DeepSeek V3.1 and MiniMax-M2 were here (checked against their templates) and were removed in 2026-11-12, since
// no hosted service offers a raw prompt endpoint we could test them on: see docs/local-models.md 9.7, and the history of this file.
