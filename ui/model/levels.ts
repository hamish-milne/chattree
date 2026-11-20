/**
 * Thinking levels: the catalog names a few (`off`, `low`, `high` ...) and the settings that make each. The settings form shows them as one
 * choice instead of the several fields they set (`thinking`, `effort`, `reasoning`).
 */

type Json = Record<string, unknown>;

/** Whether two settings values are the same (they are JSON). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  const get = (o: object, k: string): unknown => Reflect.get(o, k);
  return ka.length === kb.length && ka.every((k) => k in b && same(get(a, k), get(b, k)));
}
export interface Level {
  name: string;
  settings: Json;
}

/** The settings keys any level sets: what choosing a level takes over. */
export const levelKeys = (levels: readonly Level[]): string[] => [...new Set(levels.flatMap((l) => Object.keys(l.settings)))];

/** The level the settings are at: the one whose every value is there (the most specific if two are). Undefined when none is set; `custom` when the keys are there but no level matches. */
export function activeLevel(levels: readonly Level[], value: Json): string | undefined {
  const matches = levels.filter((l) => Object.entries(l.settings).every(([k, v]) => same(value[k], v)));
  const best = matches.reduce<Level | undefined>(
    (a, l) => (a === undefined || Object.keys(l.settings).length > Object.keys(a.settings).length ? l : a),
    undefined,
  );
  if (best !== undefined) return best.name;
  return levelKeys(levels).some((k) => value[k] !== undefined) ? "custom" : undefined;
}

/** The settings with the level in effect: the keys levels set are replaced by that level's. With no level they are all left out (the provider's default). */
export function withLevel(levels: readonly Level[], value: Json, name: string | undefined): Json {
  const out: Json = { ...value };
  for (const k of levelKeys(levels)) delete out[k];
  return { ...out, ...(levels.find((l) => l.name === name)?.settings ?? {}) };
}
