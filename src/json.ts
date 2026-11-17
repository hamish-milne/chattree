/** Reading JSON that came from outside: the shape is the other side's promise, so each value is checked where it is received. */

/** A JSON object as it comes off the wire: keys are known, values are not. */
export type Json = Record<string, unknown>;

export const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The object, or undefined when the value is absent or not an object. */
export const asJson = (value: unknown): Json | undefined => (isJson(value) ? value : undefined);

/** The object, or an empty one: for a part of a message that is optional as a whole. */
export const jsonOr = (value: unknown): Json => (isJson(value) ? value : {});

/** The objects in a list; anything else in it, or a value that is not a list, is left out. */
export const jsonList = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isJson) : []);

/** The string, or undefined when the value is absent or not a string. */
export const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** A field that must be a whole number (an index, say). */
export function wireIndex(value: unknown, what: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new TypeError(`${what} should be a whole number, not ${value === null ? "null" : typeof value}`);
}

/** The text parsed as a JSON object; anything else (including malformed text) throws. */
export function parseJsonObject(text: string, what: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError(`${what} is not valid JSON`);
  }
  if (!isJson(parsed)) throw new TypeError(`${what} is not a JSON object`);
  return parsed;
}

/** Whether a thrown value is an error with this `code` (`ENOENT`, `ESRCH` and so on). */
export const hasCode = (error: unknown, code: string): boolean => isJson(error) && error["code"] === code;
