/**
 * A small JSON Schema checker for the mock controller, so editing a form in the preview shows real issues (a number
 * out of range, a name that does not fit its pattern, a value that is not one of the choices). The real controller
 * validates with the harness's own validator; this covers the parts of the schema the fixtures use.
 */
import type { FormIssue } from "../model/form.ts";

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const objectOf = (x: unknown): Json => (isObject(x) ? x : {});

export function validateMock(schema: Json, value: unknown, path: string[] = []): FormIssue[] {
  const at = path.join(".");
  const bad = (message: string): FormIssue[] => [
    {
      path: at,
      message: typeof schema["errorMessage"] === "string" ? schema["errorMessage"] : message,
    },
  ];
  if (value === undefined) return [];
  if ("const" in schema && schema["const"] !== value) return bad(`must be ${String(schema["const"])}`);
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) return bad(`must be one of ${schema["enum"].join(", ")}`);
  if (Array.isArray(schema["oneOf"])) {
    // Variants are told apart by their `$tag`; the issues are those of the one the value names.
    const tag = isObject(value) ? value["$tag"] : undefined;
    const variants = schema["oneOf"].filter(isObject);
    const chosen = variants.find((v) => objectOf(objectOf(v["properties"])["$tag"])["const"] === tag);
    if (chosen === undefined)
      return [
        {
          path: [...path, "$tag"].join("."),
          message: `must be one of ${variants.map((v) => String(objectOf(objectOf(v["properties"])["$tag"])["const"])).join(", ")}`,
        },
      ];
    return validateMock(chosen, value, path);
  }
  if (Array.isArray(schema["anyOf"])) {
    const options = schema["anyOf"].filter(isObject);
    return options.some((o) => validateMock(o, value, path).length === 0) ? [] : bad("is not an accepted form");
  }
  switch (schema["type"]) {
    case "string": {
      if (typeof value !== "string") return bad("must be text");
      if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) return bad("must not be empty");
      if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"])
        return bad(`must be at most ${schema["maxLength"]} characters`);
      if (typeof schema["pattern"] === "string" && !new RegExp(schema["pattern"]).test(value))
        return bad(`does not match ${schema["pattern"]}`);
      if (schema["format"] === "url" && !URL.canParse(value)) return bad("must be a URL");
      return [];
    }
    case "boolean":
      return typeof value === "boolean" ? [] : bad("must be true or false");
    case "number":
    case "integer": {
      if (typeof value !== "number" || Number.isNaN(value)) return bad("must be a number");
      if (schema["type"] === "integer" && !Number.isInteger(value)) return bad("must be a whole number");
      if (typeof schema["minimum"] === "number" && value < schema["minimum"]) return bad(`must be at least ${schema["minimum"]}`);
      if (typeof schema["maximum"] === "number" && value > schema["maximum"]) return bad(`must be at most ${schema["maximum"]}`);
      if (typeof schema["exclusiveMinimum"] === "number" && value <= schema["exclusiveMinimum"])
        return bad(`must be more than ${schema["exclusiveMinimum"]}`);
      if (typeof schema["exclusiveMaximum"] === "number" && value >= schema["exclusiveMaximum"])
        return bad(`must be less than ${schema["exclusiveMaximum"]}`);
      return [];
    }
    case "array": {
      if (!Array.isArray(value)) return bad("must be a list");
      if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) return bad(`needs at least ${schema["minItems"]}`);
      const items = schema["items"];
      return isObject(items) ? value.flatMap((v, i) => validateMock(items, v, [...path, String(i)])) : [];
    }
    case "object": {
      if (!isObject(value)) return bad("must be an object");
      const props = objectOf(schema["properties"]);
      const patterns = Object.values(objectOf(schema["patternProperties"]));
      const extra = isObject(schema["additionalProperties"])
        ? schema["additionalProperties"]
        : patterns.length === 1
          ? patterns[0]
          : undefined;
      const names = objectOf(schema["propertyNames"]);
      const out: FormIssue[] = [];
      if (Array.isArray(schema["required"]))
        for (const r of schema["required"])
          if (typeof r === "string" && !(r in value)) out.push({ path: [...path, r].join("."), message: "is required" });
      for (const [k, v] of Object.entries(value)) {
        if (!(k in props) && k !== "$tag" && Object.keys(names).length > 0)
          out.push(
            ...validateMock({ type: "string", ...names }, k, path).map((i) => ({
              ...i,
              path: [...path, k].join("."),
              message: i.message,
            })),
          );
        const s = props[k] ?? extra;
        if (isObject(s)) out.push(...validateMock(s, v, [...path, k]));
        else if (schema["additionalProperties"] === false && !(k in props))
          out.push({
            path: [...path, k].join("."),
            message: "is not a setting",
          });
      }
      return out;
    }
    default:
      return [];
  }
}
