import type { Dialect } from "../dialect.ts";
import { harmony } from "./harmony.ts";

/** The dialects that ship with chattree, by id (docs/local-models.md, section 9). */
export function builtinDialects(): Dialect[] {
  return [harmony];
}
