import type { Dialect } from "../dialect.ts";
import { gemma } from "./gemma.ts";
import { harmony } from "./harmony.ts";
import { qwenXml } from "./qwen-xml.ts";

/** The dialects that ship with chattree, by id (docs/local-models.md, section 9). */
export function builtinDialects(): Dialect[] {
  return [gemma, harmony, qwenXml];
}

/** The dialect for a model by the family its name says (gpt-oss, Qwen, Gemma), if any. */
export function dialectForModel(name: string): string | undefined {
  const m = name.toLowerCase();
  return m.includes("gpt-oss") ? "harmony" : m.includes("qwen") ? "qwen-xml" : m.includes("gemma") ? "gemma" : undefined;
}
