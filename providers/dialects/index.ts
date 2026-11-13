import type { Dialect } from "../dialect.ts";
import { familyDialects } from "./families.ts";
import { gemma } from "./gemma.ts";
import { harmony } from "./harmony.ts";
import { qwenXml } from "./qwen-xml.ts";

/** The dialects that ship with chattree, by id (docs/local-models.md, section 9). */
export function builtinDialects(): Dialect[] {
  return [gemma, harmony, qwenXml, ...familyDialects()];
}

/**
 * The dialect for a model by the family its name starts with, if any. Qwen is the `qwen-xml` format (Qwen3.5 and the Coder models); older
 * Qwen3 and Qwen2.5 write the `hermes` format, which has to be asked for.
 */
export function dialectForModel(name: string): string | undefined {
  // The start of the model's own name (after any `org/`), never a part of it: `my-qwen-tune` is nobody's guess, and a base model's name inside a
  // fine-tune's (DeepSeek-R1-Distill-Qwen) does not make it that base model.
  const m = (name.toLowerCase().split("/").at(-1) as string).replace(/^[-_.\s]+/, "");
  // Only the generations whose format a dialect reproduces: older models of the same makers (DeepSeek-MoE-16B, ChatGLM, Mistral 7B) were not trained for these calls.
  const by: [RegExp, string][] = [[/^gpt-oss/, "harmony"], [/^qwen/, "qwen-xml"], [/^gemma/, "gemma"], [/^glm-?4\.[56]/, "glm46"], [/^glm-?4\.[789]|^glm-?[5-9]/, "glm"], [/^devstral|^mistral-small-3/, "mistral"], [/^kimi-vl/, "kimi-vl"], [/^deepseek-r1/, "deepseek-r1"]];
  return by.find(([re]) => re.test(m))?.[1];
}
