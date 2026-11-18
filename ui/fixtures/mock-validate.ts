/**
 * A small JSON Schema checker for the mock controller, so editing a form in the preview shows real issues (a number
 * out of range, a value that is not one of the choices). The real controller validates with the harness's own
 * validator; this covers only what the fixture schemas use.
 */
import type { FormIssue } from "../model/form.ts";

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);

export function validateMock(schema: Json, value: unknown, path: string[] = []): FormIssue[] {
  const at = path.join(".");
  const bad = (message: string): FormIssue[] => [{ path: at, message }];
  if (value === undefined) return [];
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) return bad(`must be one of ${schema["enum"].join(", ")}`);
  switch (schema["type"]) {
    case "string":
      return typeof value === "string" ? [] : bad("must be text");
    case "boolean":
      return typeof value === "boolean" ? [] : bad("must be true or false");
    case "number":
    case "integer": {
      if (typeof value !== "number" || Number.isNaN(value)) return bad("must be a number");
      if (schema["type"] === "integer" && !Number.isInteger(value)) return bad("must be a whole number");
      if (typeof schema["minimum"] === "number" && value < schema["minimum"]) return bad(`must be at least ${schema["minimum"]}`);
      if (typeof schema["maximum"] === "number" && value > schema["maximum"]) return bad(`must be at most ${schema["maximum"]}`);
      return [];
    }
    case "array":
      return Array.isArray(value) ? [] : bad("must be a list");
    case "object": {
      if (!isObject(value)) return bad("must be an object");
      const props = isObject(schema["properties"]) ? schema["properties"] : {};
      const extra = schema["additionalProperties"];
      return Object.entries(value).flatMap(([k, v]) => {
        const s = props[k] ?? extra;
        return isObject(s) ? validateMock(s, v, [...path, k]) : [];
      });
    }
    default:
      return [];
  }
}
