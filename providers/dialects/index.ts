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
 * The dialect for a model by the family its name says, if any. Qwen is the `qwen-xml` format (Qwen3.5 and the Coder models); older
 * Qwen3 and Qwen2.5 write the `hermes` format, which has to be asked for.
 */
export function dialectForModel(name: string): string | undefined {
  const m = name.toLowerCase();
  const by: [string, string][] = [["gpt-oss", "harmony"], ["qwen", "qwen-xml"], ["gemma", "gemma"], ["kimi", "kimi"], ["deepseek", "deepseek"], ["glm", "glm"], ["minimax", "minimax"], ["devstral", "mistral"], ["mistral", "mistral"]];
  return by.find(([k]) => m.includes(k))?.[1];
}
