/** Reading fields of JSON that came off the wire, where the shape is the other side's promise and not ours. */

/** A field that must be a string when present; absent or null is the empty string. Anything else is a malformed message. */
export function optString(value: unknown, what: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  throw new TypeError(`${what} should be a string, not ${typeof value}`);
}

/** A field that must be a string. */
export function wireString(value: unknown, what: string): string {
  if (typeof value === "string") return value;
  throw new TypeError(`${what} should be a string, not ${value === null ? "null" : typeof value}`);
}

/** The text of an error message field on a failure path, where throwing would hide the failure itself: anything not a string is shown as JSON. */
export function messageText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/** What was thrown, as text: an `Error`'s message, or the value itself when it is not one. */
export function thrownText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error) ?? typeof error;
}

export { asJson, asString, isJson, jsonList, jsonOr, parseJsonObject, wireIndex, type Json } from "../src/json.ts";
