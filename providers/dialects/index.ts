import type { Dialect } from "../dialect.ts";
import { gemma } from "./gemma.ts";
import { harmony } from "./harmony.ts";
import { qwenXml } from "./qwen-xml.ts";

/** The dialects that ship with chattree, by id (docs/local-models.md, section 9). */
export function builtinDialects(): Dialect[] {
  return [gemma, harmony, qwenXml];
}
